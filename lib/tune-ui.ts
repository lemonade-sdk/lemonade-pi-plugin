/**
 * @lemonade/lemonade-provider
 *
 * Shared pure logic for `/lemonade tune` (docs/analysis-2026-09-07.md):
 *
 *   - renderEntryOverview — human-readable one-block-per-model view with
 *     per-field provenance tags (✓probe / [gguf]) taken from the entry's
 *     `_meta` block (written by buildTunedEntry);
 *   - tunePickerOptions   — rows for the no-arg `/lemonade tune` interactive
 *     picker (pi-compatible server models, catalog status per row);
 *   - validators          — budgets monotonicity, budget ≤ maxTokens − 1024,
 *     sampling value ranges (all pure, unit-tested; shared by the
 *     fullscreen mask in tune-screen.ts).
 *
 * Pure functions are exported separately from any UI so the tests never
 * need a real UI.
 */

import type { Budgets } from "./model-params.js";
import { isPiVisible } from "./models.js";

// ─── UI contract (structural subset of pi's ctx.ui) ────────────────────────

type Entry = Record<string, unknown>;

// ─── Provenance ─────────────────────────────────────────────────────────────

interface Provenance {
  source: "probe" | "gguf";
  ref?: string;
}

/** Field → provenance, read from the entry's `_meta.paramsSource`. */
export function provenanceOf(entry: Entry): Map<string, Provenance> {
  const map = new Map<string, Provenance>();
  const meta = entry?._meta as
    | { paramsSource?: { field: string; source: "probe" | "gguf"; ref?: string }[] }
    | undefined;
  for (const p of meta?.paramsSource ?? []) {
    if (p?.field) map.set(p.field, { source: p.source, ref: p.ref });
  }
  return map;
}

// ─── Entry overview (readable rendering) ────────────────────────────────────

function fmtBool(v: unknown): string {
  return v === true ? "true" : v === false ? "false" : "—";
}

function fmtSamplingRow(row: unknown): string {
  if (!row || typeof row !== "object") return "— (server defaults stand)";
  const parts = Object.entries(row as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} ${v}`);
  return parts.length > 0 ? parts.join("  ") : "— (server defaults stand)";
}

/**
 * Human-readable view of one catalog entry (the screen the old code
 * replaced the JSON dump with).
 *
 * opts carry live-server context (loaded flag, ctx window, server tags);
 * all optional — the same renderer works for offline catalogued models.
 */
export function renderEntryOverview(
  id: string,
  entry: Entry,
  opts?: {
    tier?: string;
    loaded?: boolean;
    ctxWindow?: number;
    serverTags?: string[];
  },
): string {
  const prov = provenanceOf(entry);
  const lines: string[] = [];

  const head = [id];
  if (opts?.tier) head.push(`[${opts.tier}]`);
  if (opts?.loaded) head.push("● loaded");
  if (opts?.ctxWindow) head.push(`ctx ${opts.ctxWindow.toLocaleString()}`);
  lines.push(head.join("   "));
  if (opts?.serverTags?.length) lines.push(`server tags:   [${opts.serverTags.join(", ")}]`);

  // capabilities — ✓probe marks fields proven by the live probe
  const caps = ["reasoning", "vision", "disableReasoning"].map((k) => {
    const tag = prov.get(k)?.source === "probe" ? " ✓probe" : "";
    return `${k} ${fmtBool(entry[k])}${tag}`;
  });
  lines.push(`capabilities:  ${caps.join(" · ")}`);

  lines.push(`ceiling:       maxTokens ${entry.maxTokens ?? "—"}`);

  const b = entry.budgets as Budgets | undefined;
  if (b) {
    const levels: (keyof Budgets)[] = ["minimal", "low", "medium", "high"];
    lines.push(`budgets:       ${levels.map((l) => `${l} ${b[l] ?? "—"}`).join(" · ")}`);
  } else {
    lines.push(`budgets:       — (pi defaults stand)`);
  }

  // sampling rows — [gguf] marks the checkpoint file the kvs came from
  for (const [rowKey, label] of [
    ["thinking", "thinking smp:"],
    ["nonThinking", "nonThink  smp:"],
  ] as const) {
    const fields = [...prov.entries()].filter(
      ([f, p]) => f.startsWith(`${rowKey}.`) && p.source === "gguf",
    );
    const ggufTag = fields.length > 0 ? `  [gguf: ${fields[0][1].ref ?? "?"}]` : "";
    lines.push(`${label} ${fmtSamplingRow(entry[rowKey])}${ggufTag}`);
  }

  const off = entry.offParams as Record<string, unknown> | undefined;
  if (off) {
    lines.push(
      `off params:    ${Object.entries(off)
        .map(([k, v]) => `${k}=${typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}`)
        .join("  ")}`,
    );
  }

  const effort = entry.effortMap as Record<string, string> | undefined;
  if (effort) {
    lines.push(`effortMap:     ${Object.entries(effort).map(([k, v]) => `${k}→${v}`).join(" · ")}`);
  }

  const meta = entry?._meta as { probedAt?: string; probe?: Record<string, unknown> } | undefined;
  if (meta?.probedAt) {
    const bits: string[] = [];
    if (typeof meta.probe?.thinking === "boolean") bits.push(`thinking ${meta.probe.thinking ? "✓" : "✗"}`);
    if (typeof meta.probe?.vision === "boolean") bits.push(`vision ${meta.probe.vision ? "✓" : "✗"}`);
    if (typeof meta.probe?.honorsBudget === "boolean") bits.push(`honorsBudget ${meta.probe.honorsBudget ? "✓" : "✗"}`);
    lines.push(`probed:        ${meta.probedAt}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }

  return lines.join("\n");
}

// ─── Interactive picker (no-arg `/lemonade tune`) ───────────────────────────

export interface CatalogView {
  user?: Record<string, Entry>;
  plugin?: Record<string, Entry>;
}

function entrySummary(e: Entry): string {
  const bits: string[] = [];
  if (e.reasoning) bits.push("reasoning");
  if (e.vision) bits.push("vision");
  if (typeof e.maxTokens === "number") bits.push(`maxTokens ${e.maxTokens}`);
  return bits.length > 0 ? bits.join(" · ") : "(no capability flags)";
}

export interface TunePickerOption {
  label: string;
  id: string;
}

/**
 * Options for the no-arg `/lemonade tune` interactive picker. One compact
 * row per pi-compatible server model (chat + tool-calling labels, same gate
 * as the picker registration — LEMONADE_ALL_MODELS=1 shows everything).
 * Explicit `/lemonade tune <id>` remains the unfiltered route.
 * `[— not in model-params]` marks models with no user- or plugin-tier entry.
 */
export function tunePickerOptions(
  serverModels: { id: string; loaded?: boolean; labels?: string[] }[],
  catalog: CatalogView,
): TunePickerOption[] {
  return serverModels
    .filter((m) => isPiVisible({ id: m.id, labels: m.labels }))
    .map((m) => {
    const user = catalog.user?.[m.id];
    const plugin = catalog.plugin?.[m.id];
    const tier = user ? "[user]" : plugin ? "[plugin]" : "[— not in model-params]";
    const summary = user || plugin ? entrySummary(user ?? plugin ?? {}) : "";
    const parts = [m.loaded ? "●" : "○", m.id, tier];
    if (summary) parts.push(summary);
    return { label: parts.join("  "), id: m.id };
  });
}

// ─── Validation (pure) ──────────────────────────────────────────────────────

/**
 * Validate the budgets row: present levels must be monotonic
 * (minimal ≤ low ≤ medium ≤ high, over the keys that are present) and,
 * when maxTokens is set, each budget must fit under maxTokens − 1024
 * (leaves room for the answer body inside the ceiling).
 */
export function validateBudgets(budgets: Budgets, maxTokens?: number): string | undefined {
  const levels: (keyof Budgets)[] = ["minimal", "low", "medium", "high"];
  const present = levels.filter((l) => typeof budgets[l] === "number") as (keyof Budgets)[];
  for (let i = 1; i < present.length; i++) {
    const prev = budgets[present[i - 1]] as number;
    const cur = budgets[present[i]] as number;
    if (cur < prev) {
      return `not monotonic: ${present[i - 1]} (${prev}) > ${present[i]} (${cur})`;
    }
  }
  if (typeof maxTokens === "number" && maxTokens > 0) {
    const cap = maxTokens - 1024;
    for (const l of present) {
      const v = budgets[l] as number;
      if (v > cap) return `${l} (${v}) exceeds maxTokens − 1024 = ${cap}`;
    }
  }
  return undefined;
}

/**
 * Validate one sampling value for its field. Returns the number when valid,
 * or an error-message string. "" (Enter) → "keep".
 */
export function validateSamplingValue(
  field: string,
  raw: string | undefined,
): number | "keep" | string {
  const v = (raw ?? "").trim();
  if (v === "") return "keep";
  const n = Number(v);
  if (!Number.isFinite(n)) return `"${v}" is not a number`;
  switch (field) {
    case "temperature":
      return n >= 0 ? n : `temperature must be ≥ 0 (got ${n})`;
    case "top_p":
      return n > 0 && n <= 1 ? n : `top_p must be in (0, 1] (got ${n})`;
    case "top_k":
      return Number.isInteger(n) && n >= 1 ? n : `top_k must be an integer ≥ 1 (got ${v})`;
    case "min_p":
      return n >= 0 && n < 1 ? n : `min_p must be in [0, 1) (got ${n})`;
    case "presence_penalty":
      return n >= 0 ? n : `presence_penalty must be ≥ 0 (got ${n})`;
    case "repetition_penalty":
      return n >= 0 ? n : `repetition_penalty must be ≥ 0 (got ${n})`;
    case "maxTokens":
      return Number.isInteger(n) && n > 0 ? n : `maxTokens must be an integer > 0 (got ${v})`;
    case "contextWindow":
      return Number.isInteger(n) && n > 0 ? n : `contextWindow must be an integer > 0 (got ${v})`;
    default:
      return `unknown field "${field}"`;
  }
}

