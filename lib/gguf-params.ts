/**
 * @lemonade/lemonade-provider
 *
 * Minimal GGUF header parser for model sampling metadata.
 *
 * llama.cpp's `convert_hf_to_gguf.py` embeds the checkpoint's
 * `generation_config.json` values as `general.sampling.*` kvs (llama.cpp
 * PR #17120). Reading them straight from the checkpoint file is the most
 * reliable source of vendor sampling values: checkpoint-exact, machine
 * readable, no auth for public repos.
 *
 * This parser only needs the KV table, which sits in the first kilobytes of
 * the file — a single HTTP range request for the first megabyte is enough
 * for every checkpoint seen to date (even 100B+ files).
 *
 * GGUF v2/v3 layout (little-endian, per ggml-org/llama.cpp gguf-py):
 *
 *   magic u32 (0x46475547 "GGUF") | version u32
 *   tensor_count u64 | kv_count u64
 *   per KV: key_len u64 | key bytes | type u32 | value
 *
 * Key length is a u64 (v2/v3) — NOT the older zstr encoding, which is why
 * naive parsers misalign on every field after the first.
 *
 * The walk is defensive: truncation mid-KV, unknown types, and arrays are
 * all stop conditions that return whatever was parsed so far (sampling kvs
 * are typically within the first few dozen entries).
 */

/** Values extracted from a GGUF header. */
export interface GgufSamplingParams {
  temp?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
}

export interface GgufHeaderInfo {
  /** `general.sampling.*` kvs, when present. */
  sampling?: GgufSamplingParams;
  /** `general.architecture` (e.g. "qwen35"), when present. */
  architecture?: string;
  /** `general.base_model.0.repo_url` — the official HF repo, when embedded. */
  baseModelRepo?: string;
  /** True when the KV table could not be fully read (range was too small). */
  truncated?: boolean;
}

const GGUF_MAGIC = 0x46554747; // bytes "GGUF" read as little-endian u32
const HEADER_RANGE_BYTES = 1_048_576; // 1 MiB — far beyond any real KV table

/**
 * Split a Lemonade checkpoint pointer into an HuggingFace resolve URL.
 *
 * Lemonade reports checkpoints as `"<repo_id>:<file>"` where repo_id is the
 * HF repo (e.g. `unsloth/Qwen3.8-27B-GGUF`) and file is the GGUF name.
 * Returns undefined when the pointer is not in that shape (e.g. a bare
 * local path) — the caller then skips the GGUF tier.
 */
export function checkpointToHfUrl(checkpoint: string | undefined): string | undefined {
  if (!checkpoint) return undefined;
  const idx = checkpoint.indexOf(":");
  if (idx <= 0 || idx === checkpoint.length - 1) return undefined;
  const repo = checkpoint.slice(0, idx).trim();
  const file = checkpoint.slice(idx + 1).trim();
  if (!repo.includes("/") || !file) return undefined;
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

/** Fetch the first megabyte of a URL (range request; falls back to a full GET). */
export async function fetchHeaderBytes(url: string, timeoutMs = 30_000): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${HEADER_RANGE_BYTES - 1}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 206 = partial content; 200 = server ignored the range (still usable if it
  // served at least the header — check length by the caller).
  if (!res.ok && res.status !== 200) {
    throw new Error(`GGUF header fetch failed: HTTP ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

type Reader = {
  bytes: Uint8Array;
  offset: number;
};

function readU32(r: Reader): number {
  if (r.offset + 4 > r.bytes.length) throw new RangeError("truncated u32");
  const v = r.bytes.subarray(r.offset, r.offset + 4);
  r.offset += 4;
  return (v[0] | (v[1] << 8) | (v[2] << 16)) >>> 0 | (v[3] * 0x1000000);
}

function readU64(r: Reader): number {
  if (r.offset + 8 > r.bytes.length) throw new RangeError("truncated u64");
  const lo = readU32(r);
  const hi = readU32(r);
  // We only use u64s as lengths/counts — clamp to safe integers.
  return hi * 0x100000000 + lo;
}

function readString(r: Reader): string {
  const len = readU64(r);
  if (!Number.isSafeInteger(len) || len < 0 || r.offset + len > r.bytes.length) {
    throw new RangeError(`invalid string length ${len}`);
  }
  const s = Buffer.from(r.bytes.subarray(r.offset, r.offset + len)).toString("utf8");
  r.offset += len;
  return s;
}

function readScalar(r: Reader, type: number): number | undefined {
  switch (type) {
    case 0: case 1: { // uint8 / int8
      if (r.offset + 1 > r.bytes.length) throw new RangeError("truncated");
      const v = r.bytes[r.offset];
      r.offset += 1;
      return type === 1 ? (v >= 0x80 ? v - 0x100 : v) : v;
    }
    case 2: case 3: { // uint16 / int16
      if (r.offset + 2 > r.bytes.length) throw new RangeError("truncated");
      const v = r.bytes[r.offset] | (r.bytes[r.offset + 1] << 8);
      r.offset += 2;
      return type === 3 ? (v >= 0x8000 ? v - 0x10000 : v) : v;
    }
    case 4: case 5: { // uint32 / int32
      const v = readU32(r);
      return type === 5 ? (v >= 0x80000000 ? v - 0x100000000 : v) : v;
    }
    case 6: { // f32
      if (r.offset + 4 > r.bytes.length) throw new RangeError("truncated");
      const f = Buffer.from(r.bytes.subarray(r.offset, r.offset + 4));
      r.offset += 4;
      return f.readFloatLE(0);
    }
    case 7: { // bool
      if (r.offset + 1 > r.bytes.length) throw new RangeError("truncated");
      const v = r.bytes[r.offset];
      r.offset += 1;
      return v ? 1 : 0;
    }
    case 10: case 11: { // u64 / i64
      return readU64(r);
    }
    case 12: { // f64
      if (r.offset + 8 > r.bytes.length) throw new RangeError("truncated");
      const f = Buffer.from(r.bytes.subarray(r.offset, r.offset + 8));
      r.offset += 8;
      return f.readDoubleLE(0);
    }
    default:
      throw new RangeError(`unsupported scalar type ${type}`);
  }
}

/** Read a GGUF value of the given type. Arrays and strings return objects/strings. */
function readValue(r: Reader, type: number): unknown {
  switch (type) {
    case 8:
      return readString(r);
    case 9: { // array: u32 elem_type | u64 count | elements
      const elemType = readU32(r);
      const count = readU64(r);
      if (!Number.isSafeInteger(count) || count < 0) throw new RangeError(`bad array count ${count}`);
      const out: unknown[] = [];
      for (let i = 0; i < count; i++) {
        out.push(readValue(r, elemType));
      }
      return out;
    }
    default:
      return readScalar(r, type);
  }
}

/**
 * Parse the KV table from a GGUF file header buffer.
 *
 * Returns undefined when the buffer is not a GGUF file (bad magic or
 * version). Throws RangeError on structural corruption before any KV —
 * callers treat both as "no GGUF data available".
 */
export function parseGgufHeader(bytes: Uint8Array): GgufHeaderInfo | undefined {
  const r: Reader = { bytes, offset: 0 };
  const magic = readU32(r);
  if (magic !== GGUF_MAGIC) return undefined;
  const version = readU32(r);
  if (version < 2 || version > 3) return undefined;
  readU64(r); // tensor_count — not needed
  const kvCount = readU64(r);

  const info: GgufHeaderInfo = {};
  const kv: Record<string, unknown> = {};

  const hasAllSampling = () =>
    typeof kv["general.architecture"] === "string" &&
    typeof kv["general.sampling.temp"] === "number" &&
    typeof kv["general.sampling.top_p"] === "number" &&
    typeof kv["general.sampling.top_k"] === "number";

  for (let i = 0; i < kvCount; i++) {
    let key: string;
    let value: unknown;
    try {
      key = readString(r);
      const type = readU32(r);
      value = readValue(r, type);
    } catch (err) {
      // Truncation or unknown structure mid-table — keep what we have.
      if (i === 0) throw err; // no kvs at all → treat as unparseable
      info.truncated = true;
      break;
    }
    kv[key] = value;
    // Everything we surface lives under general.* — once the key leaves
    // that namespace and the fields we want are all present, stop walking
    // (the rest of the table is architecture params and, on some files,
    // multi-megabyte tokenizer arrays well past the 1 MiB range).
    if (!key.startsWith("general.") && hasAllSampling()) {
      info.truncated = true; // table not fully read (by design)
      break;
    }
  }

  const arch = kv["general.architecture"];
  if (typeof arch === "string") info.architecture = arch;

  const num = (k: string): number | undefined => {
    const v = kv[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  // Sampling values are f32 in the file; rounding to 4 decimals removes the
  // float32→float64 artifact (0.95 stored as 0.949999988…) so generated
  // catalog entries match the vendor documentation.
  const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
  const sampling: GgufSamplingParams = {};
  const temp = num("general.sampling.temp");
  const topP = num("general.sampling.top_p");
  const topK = num("general.sampling.top_k");
  const minP = num("general.sampling.min_p");
  if (temp !== undefined) sampling.temp = round4(temp);
  if (topP !== undefined) sampling.top_p = round4(topP);
  if (topK !== undefined) sampling.top_k = topK;
  if (minP !== undefined) sampling.min_p = round4(minP);
  if (Object.keys(sampling).length > 0) info.sampling = sampling;

  const repoUrl = kv["general.base_model.0.repo_url"];
  if (typeof repoUrl === "string") info.baseModelRepo = repoUrl;

  return info;
}

/**
 * Fetch + parse `general.sampling.*` (and friends) from the checkpoint
 * behind a Lemonade checkpoint pointer. Returns undefined when the pointer
 * is not HF-shaped, the fetch fails, or the file carries no sampling kvs —
 * callers fall back to "leave unset".
 */
export async function fetchGgufParams(
  checkpoint: string | undefined,
  timeoutMs = 30_000,
): Promise<GgufHeaderInfo | undefined> {
  const url = checkpointToHfUrl(checkpoint);
  if (!url) return undefined;
  try {
    const bytes = await fetchHeaderBytes(url, timeoutMs);
    const info = parseGgufHeader(bytes);
    if (!info) return undefined;
    return info;
  } catch {
    return undefined; // offline, gated repo, non-GGUF, … → tier skipped
  }
}
