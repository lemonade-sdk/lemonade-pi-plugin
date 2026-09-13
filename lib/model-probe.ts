/**
 * @lemonade/lemonade-provider
 *
 * Live capability probes for `/lemonade tune <model>` — ask the RUNNING
 * server what a model actually does, instead of trusting name patterns or
 * tags (which are incomplete: several thinking-capable MTP models ship
 * without a `reasoning` label, and one labeled model emits no
 * reasoning_content).
 *
 * Probes:
 *   - thinking  — send a budgeted request; does `reasoning_content` come
 *                 back? Does the server HONOR thinking_budget_tokens
 *                 (short budget → measurably shorter reasoning)?
 *   - vision    — send an image content-part; error → no vision, answer → yes.
 *
 * Probes are SLOW when the model is not loaded (the server loads it first —
 * 30s to minutes for large models). The caller surfaces progress via
 * ctx.ui.notify and should warn before starting.
 */

import type { LemonadeModelInfo } from "./types.js";

export interface ThinkingProbeResult {
  /** Server returned reasoning_content (non-empty) for the budgeted request. */
  emitsReasoning: boolean;
  /** reasoning_budget_tokens/thinking_budget_tokens measurably capped the output. */
  honorsBudget: boolean | undefined; // undefined = could not determine
  reasoningCharsSmall: number;
  reasoningCharsLarge: number;
  error?: string;
}

export interface VisionProbeResult {
  vision: boolean;
  detail: string;
}

/** Tiny 1x1 red PNG (base64) — smallest valid image the backends accept. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const PROBE_PROMPT = "What is 27 * 43? Answer with the number only.";

interface ChatResponse {
  choices?: {
    message?: { content?: string; reasoning_content?: string };
    finish_reason?: string;
  }[];
  error?: { message?: string } | string;
}

async function chat(
  baseUrl: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  timeoutMs = 600_000,
): Promise<ChatResponse> {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) {
    const msg = typeof data.error === "string" ? data.error : data.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Probe thinking support: two budgeted requests (small vs large
 * thinking_budget_tokens). reasoning_content on the large run proves
 * emission; a large run at least ~3x the small run's length proves the
 * server honors the budget field.
 */
export async function probeThinking(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<ThinkingProbeResult> {
  const run = (budget: number) =>
    chat(baseUrl, apiKey, {
      model: modelId,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: 1024,
      temperature: 0.1,
      thinking_budget_tokens: budget,
    });

  const fail = (error: string): ThinkingProbeResult => ({
    emitsReasoning: false,
    honorsBudget: undefined,
    reasoningCharsSmall: 0,
    reasoningCharsLarge: 0,
    error,
  });

  let small: ChatResponse;
  try {
    small = await run(256);
  } catch (e) {
    return fail(String(e instanceof Error ? e.message : e));
  }
  let large: ChatResponse;
  try {
    large = await run(4096);
  } catch (e) {
    return fail(`second probe failed: ${String(e instanceof Error ? e.message : e)}`);
  }

  const rcSmall = (small.choices?.[0]?.message?.reasoning_content ?? "").length;
  const rcLarge = (large.choices?.[0]?.message?.reasoning_content ?? "").length;
  return {
    emitsReasoning: rcLarge > 0,
    honorsBudget: rcLarge > 0 ? rcLarge >= Math.max(2 * rcSmall, 64) : undefined,
    reasoningCharsSmall: rcSmall,
    reasoningCharsLarge: rcLarge,
  };
}

/** Probe vision support with a tiny image content-part. */
export async function probeVision(
  baseUrl: string,
  apiKey: string | undefined,
  modelId: string,
): Promise<VisionProbeResult> {
  try {
    const res = await chat(baseUrl, apiKey, {
      model: modelId,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What color is this image? One word." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${TINY_PNG_B64}` } },
          ],
        },
      ],
      max_tokens: 32,
      temperature: 0,
    });
    const content = res.choices?.[0]?.message?.content ?? "";
    // Reasoning models may spend the whole (small) token budget on
    // reasoning_content and return empty content — an HTTP 200 with a
    // processed image still proves the vision path works.
    if (!content.trim() && !(res.choices?.[0]?.message?.reasoning_content ?? "")) {
      return { vision: false, detail: "empty response to image" };
    }
    return { vision: true, detail: `answered: "${(content || res.choices?.[0]?.message?.reasoning_content || "").trim().slice(0, 60)}"` };
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return { vision: false, detail: `image request failed: ${msg.slice(0, 120)}` };
  }
}

/**
 * Assemble the catalog entry to write for `/lemonade tune`. Writes ONLY
 * what was sourced or probed — no invented defaults:
 *
 *   - capabilities (reasoning/vision) — from the live probes (they win
 *     over server tags, which are wrong in both directions on several
 *     models);
 *   - sampling row — from the checkpoint's embedded GGUF
 *     `general.sampling.*` kvs, when available; placed in the row that
 *     matches the probe result (thinking row for reasoners, nonThinking
 *     row otherwise). Absent GGUF kvs → row left unset → server defaults
 *     stand, the user completes values in the editor;
 *   - everything else (budgets, ceiling, offParams, effortMap) — untouched
 *     by the probe flow; it comes from the curated example catalog or is
 *     set manually.
 *
 * Every written field is recorded in an `_meta` provenance block
 * (ignored by the tuning engine, rendered by the UI).
 */
export interface ParamSource {
  field: string;
  source: "probe" | "gguf";
  ref?: string;
}

export interface TunedEntryMeta {
  probedAt: string;
  probe: {
    thinking?: boolean;
    vision?: boolean;
    honorsBudget?: boolean | null;
  };
  paramsSource: ParamSource[];
}

/**
 * Should the checkpoint GGUF metadata be fetched? Only when it could be
 * WRITTEN: the target sampling row must be absent from the existing entry.
 * For a catalogued, user-amended model this is false → the (slow) HF
 * metadata fetch is skipped. `targetRow` undefined (no probe knowledge,
 * e.g. skip path with no prior probe) → needed only when both rows are absent.
 */
export function ggufBackfillNeeded(
  hasCheckpoint: boolean,
  targetRow: "thinking" | "nonThinking" | undefined,
  existing: Record<string, unknown> | undefined,
): boolean {
  if (!hasCheckpoint) return false;
  if (targetRow === undefined) {
    return existing?.thinking === undefined && existing?.nonThinking === undefined;
  }
  return existing?.[targetRow] === undefined;
}

export function buildTunedEntry(
  model: LemonadeModelInfo,
  thinking: ThinkingProbeResult | undefined,
  vision: VisionProbeResult | undefined,
  gguf: { sampling?: { temp?: number; top_p?: number; top_k?: number; min_p?: number }; ref?: string } | undefined,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(existing ?? {}) };
  // No fresh probe (skip path) + prior provenance → keep it: don't fabricate
  // a new probedAt or wipe paramsSource just because the user skipped probing.
  const prevMeta = existing?._meta as TunedEntryMeta | undefined;
  const meta: TunedEntryMeta =
    !thinking && !vision && prevMeta
      ? { probedAt: prevMeta.probedAt, probe: { ...prevMeta.probe }, paramsSource: [...prevMeta.paramsSource] }
      : { probedAt: new Date().toISOString(), probe: {}, paramsSource: [] };

  if (thinking && !thinking.error) {
    out.reasoning = thinking.emitsReasoning;
    meta.probe.thinking = thinking.emitsReasoning;
    meta.probe.honorsBudget = thinking.honorsBudget ?? null;
    meta.paramsSource.push({ field: "reasoning", source: "probe" });
  }
  if (vision) {
    out.vision = vision.vision;
    meta.probe.vision = vision.vision;
    meta.paramsSource.push({ field: "vision", source: "probe" });
  }

  // GGUF sampling kvs → the row matching the probe result, only when that
  // row is absent (existing user values always win). GGUF key names map to
  // the catalog schema (temp → temperature).
  if (gguf?.sampling && meta.probe.thinking !== undefined) {
    const row: Record<string, number> = {};
    if (gguf.sampling.temp !== undefined) row.temperature = gguf.sampling.temp;
    if (gguf.sampling.top_p !== undefined) row.top_p = gguf.sampling.top_p;
    if (gguf.sampling.top_k !== undefined) row.top_k = gguf.sampling.top_k;
    if (gguf.sampling.min_p !== undefined) row.min_p = gguf.sampling.min_p;
    if (Object.keys(row).length > 0) {
      const rowKey = meta.probe.thinking ? "thinking" : "nonThinking";
      if (out[rowKey] === undefined) {
        out[rowKey] = row;
        for (const field of Object.keys(row)) {
          meta.paramsSource.push({ field: `${rowKey}.${field}`, source: "gguf", ref: gguf.ref });
        }
      }
    }
  }

  out._meta = meta;
  return out;
}
