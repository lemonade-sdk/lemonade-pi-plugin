/**
 * @lemonade/lemonade-provider
 *
 * Fullscreen tune screen for `/lemonade tune` — one at-a-glance mask per
 * model with every tunable value in a single ordered list:
 *
 *   - header: model id, tier, load state, ctx window
 *   - 21 fields in 5 groups (capabilities, ceiling, budgets, thinking
 *     sampling, nonThinking sampling)
 *   - footer: live status line + key legend
 *
 * Keys:
 *   ↑/↓ or tab/shift+tab — move between fields (wraps)
 *   ←/→                  — toggle bools / nudge numbers by the field step
 *   space / enter        — toggle bools; enter starts inline edit for numbers/strings
 *   enter (editing)      — commit (validated; error keeps the editor open)
 *   esc (editing)        — abandon the edit
 *   s                    — validate everything → write (via onCommit)
 *   q / esc / ctrl+c     — cancel (no write)
 *
 * The state machine (createTuneState/applyKey) and the renderer
 * (renderTuneScreen) are pure and unit-tested without any real UI; only the
 * bottom adapter touches pi's TUI types (structurally — the plugin types
 * against `ctx.ui.custom`'s injected arguments, not pi internals).
 */

import { validateSamplingValue, validateBudgets } from "./tune-ui.js";
import type { Budgets } from "./model-params.js";

// ─── Field table ────────────────────────────────────────────────────────────

export type FieldKind = "bool" | "number" | "string";

export interface TuneField {
  /** Dot path into the entry object, e.g. "budgets.medium", "thinking.top_p". */
  path: string;
  label: string;
  group: string;
  kind: FieldKind;
  /** Nudge step for ←/→ (numbers only). */
  step?: number;
  /** Nudge bounds (numbers only); open-ended when absent. */
  min?: number;
  max?: number;
  /** validateSamplingValue field name (defaults to the last path segment). */
  base?: string;
}

const SAMPLING: { path: string; step: number; min: number; max: number }[] = [
  { path: "temperature", step: 0.1, min: 0, max: 2 },
  { path: "top_p", step: 0.05, min: 0.01, max: 1 },
  { path: "top_k", step: 1, min: 1, max: 100 },
  { path: "min_p", step: 0.05, min: 0, max: 0.95 },
  { path: "presence_penalty", step: 0.1, min: 0, max: 3 },
  { path: "repetition_penalty", step: 0.05, min: 0, max: 2 },
];

export const TUNE_FIELDS: TuneField[] = [
  { path: "reasoning", label: "reasoning", group: "capabilities", kind: "bool" },
  { path: "vision", label: "vision", group: "capabilities", kind: "bool" },
  { path: "disableReasoning", label: "disableReasoning", group: "capabilities", kind: "bool" },
  { path: "maxTokens", label: "maxTokens", group: "ceiling", kind: "number", step: 1024, min: 1024 },
  { path: "contextWindow", label: "contextWindow", group: "ceiling", kind: "number", step: 4096, min: 4096 },
  { path: "budgets.minimal", label: "budgets.minimal", group: "budgets", kind: "number", step: 512, min: 512, base: "maxTokens" },
  { path: "budgets.low", label: "budgets.low", group: "budgets", kind: "number", step: 512, min: 512, base: "maxTokens" },
  { path: "budgets.medium", label: "budgets.medium", group: "budgets", kind: "number", step: 512, min: 512, base: "maxTokens" },
  { path: "budgets.high", label: "budgets.high", group: "budgets", kind: "number", step: 512, min: 512, base: "maxTokens" },
  ...SAMPLING.map((s) => ({ path: `thinking.${s.path}`, label: `thinking.${s.path}`, group: "thinking", kind: "number" as const, step: s.step, min: s.min, max: s.max })),
  ...SAMPLING.map((s) => ({ path: `nonThinking.${s.path}`, label: `nonThinking.${s.path}`, group: "nonThinking", kind: "number" as const, step: s.step, min: s.min, max: s.max })),
];

// ─── Path access ────────────────────────────────────────────────────────────

export function getByPath(entry: Record<string, unknown>, path: string): unknown {
  let cur: unknown = entry;
  for (const seg of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Set a dot-path value; `undefined` deletes the key (empty parents pruned). */
export function setByPath(entry: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let cur: Record<string, unknown> = entry;
  for (const seg of segs.slice(0, -1)) {
    if (cur[seg] === undefined || cur[seg] === null || typeof cur[seg] !== "object") {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  const last = segs[segs.length - 1];
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  // Prune emptied parents (budgets/thinking/nonThinking only).
  for (const parentKey of ["budgets", "thinking", "nonThinking"]) {
    const obj = entry[parentKey];
    if (obj && typeof obj === "object" && Object.keys(obj as Record<string, unknown>).length === 0) {
      delete entry[parentKey];
    }
  }
}

// ─── Whole-entry validation ─────────────────────────────────────────────────

/**
 * Validate every present numeric field plus the budgets cross-checks.
 * Returns the first error message, or undefined when the entry is valid.
 */
export function validateTuneEntry(entry: Record<string, unknown>): string | undefined {
  for (const f of TUNE_FIELDS) {
    if (f.kind !== "number") continue;
    const v = getByPath(entry, f.path);
    if (v === undefined) continue;
    const out = validateSamplingValue(f.base ?? f.path.split(".")[f.path.split(".").length - 1], String(v));
    if (typeof out === "string") return `${f.path}: ${out}`;
  }
  const budgets = entry.budgets as Budgets | undefined;
  if (budgets && Object.keys(budgets).length > 0) {
    const err = validateBudgets(budgets, typeof entry.maxTokens === "number" ? entry.maxTokens : undefined);
    if (err) return `budgets: ${err}`;
  }
  return undefined;
}

// ─── State machine ──────────────────────────────────────────────────────────

export interface TuneScreenState {
  entry: Record<string, unknown>;
  /** Index into TUNE_FIELDS. */
  cursor: number;
  /** Inline edit in progress (numbers/strings only). */
  editing: boolean;
  buffer: string;
  /** Last validation/status message; undefined = no problem. */
  notice?: string;
  dirty: boolean;
}

export function createTuneState(entry: Record<string, unknown>): TuneScreenState {
  return {
    entry: structuredClone(entry),
    cursor: 0,
    editing: false,
    buffer: "",
    dirty: false,
  };
}

export type TuneEvent = "render" | "save" | "cancel" | "none";

function keyMatches(data: string, ...literals: string[]): boolean {
  // Local shim so the pure state machine stays testable without importing
  // pi-tui; the adapter passes already-normalized input (see applyRawKey).
  return literals.some((l) => data === l);
}

function fmtBool(v: unknown): string {
  return v === true ? "true" : v === false ? "false" : "—";
}

function nudge(state: TuneScreenState, dir: 1 | -1): void {
  const f = TUNE_FIELDS[state.cursor];
  if (f.kind !== "number") return;
  const step = f.step ?? 1;
  const cur = getByPath(state.entry, f.path);
  // First nudge from an unset value lands exactly on the field's min.
  if (typeof cur !== "number" || !Number.isFinite(cur)) {
    setByPath(state.entry, f.path, f.min ?? 0);
    state.dirty = true;
    return;
  }
  let next = cur + dir * step;
  if (f.max !== undefined) next = Math.min(next, f.max);
  if (f.min !== undefined) next = Math.max(next, f.min);
  // Round to the step's decimal precision.
  const decimals = (String(step).split(".")[1] ?? "").length;
  next = Number(next.toFixed(decimals));
  setByPath(state.entry, f.path, next);
  state.dirty = true;
  if (f.path.startsWith("budgets.")) {
    const err = validateTuneEntry(state.entry);
    state.notice = err;
  }
}

function commitEdit(state: TuneScreenState): void {
  const f = TUNE_FIELDS[state.cursor];
  if (f.kind === "string") {
    const v = state.buffer.trim();
    setByPath(state.entry, f.path, v === "" ? undefined : v);
    state.dirty = true;
    state.notice = undefined;
  } else {
    const base = f.base ?? f.path.split(".").pop()!;
    const out = validateSamplingValue(base, state.buffer);
    if (out === "keep") {
      // Empty buffer → keep the previous value.
    } else if (typeof out === "string") {
      state.notice = `${f.path}: ${out}`;
      // Stay in edit mode; the user fixes the buffer.
      return;
    } else {
      setByPath(state.entry, f.path, out);
      state.dirty = true;
      state.notice = f.path.startsWith("budgets.")
        ? validateTuneEntry(state.entry)
        : undefined;
    }
  }
  state.editing = false;
  state.buffer = "";
}

function toggleBool(state: TuneScreenState, forced?: boolean): void {
  const f = TUNE_FIELDS[state.cursor];
  if (f.kind !== "bool") return;
  const cur = getByPath(state.entry, f.path);
  setByPath(state.entry, f.path, forced ?? !(cur === true));
  state.dirty = true;
}

function currentString(state: TuneScreenState): string {
  const v = getByPath(state.entry, TUNE_FIELDS[state.cursor].path);
  return v === undefined ? "" : String(v);
}

/**
 * Apply one *normalized* key (see KEY_ALIASES / applyRawKey) to the state.
 * Returns what the adapter must do: re-render, hand off the entry to
 * onCommit, close without writing, or nothing.
 */
export function applyKey(state: TuneScreenState, data: string): TuneEvent {
  const n = TUNE_FIELDS.length;

  if (state.editing) {
    if (keyMatches(data, "enter")) {
      commitEdit(state);
      return "render";
    }
    if (keyMatches(data, "escape")) {
      state.editing = false;
      state.buffer = "";
      return "render";
    }
    if (keyMatches(data, "backspace")) {
      state.buffer = state.buffer.slice(0, -1);
      return "render";
    }
    if (data.length === 1 && data.charCodeAt(0) >= 32 && state.buffer.length < 64) {
      state.buffer += data;
      return "render";
    }
    return "none";
  }

  if (keyMatches(data, "up", "shift+tab")) {
    state.cursor = (state.cursor + n - 1) % n;
    return "render";
  }
  if (keyMatches(data, "down", "tab")) {
    state.cursor = (state.cursor + 1) % n;
    return "render";
  }
  if (keyMatches(data, "left", "right")) {
    const f = TUNE_FIELDS[state.cursor];
    if (f.kind === "bool") toggleBool(state);
    else nudge(state, data === "left" ? -1 : 1);
    return "render";
  }
  if (keyMatches(data, "space")) {
    const f = TUNE_FIELDS[state.cursor];
    if (f.kind === "bool") {
      toggleBool(state);
      return "render";
    }
    return "none";
  }
  if (keyMatches(data, "enter")) {
    const f = TUNE_FIELDS[state.cursor];
    if (f.kind === "bool") {
      toggleBool(state);
      return "render";
    }
    state.editing = true;
    state.buffer = currentString(state);
    return "render";
  }
  if (keyMatches(data, "s")) {
    const err = validateTuneEntry(state.entry);
    if (err) {
      state.notice = err;
      return "render";
    }
    return "save";
  }
  if (keyMatches(data, "q", "escape", "ctrl+c")) {
    return "cancel";
  }
  return "none";
}

/**
 * Normalize raw terminal input to the canonical key names applyKey expects.
 * Uses pi-tui's matchesKey/Key when available (real adapter); falls back to
 * literal sequences so tests need no TUI at all.
 */
export function applyRawKey(
  state: TuneScreenState,
  data: string,
  matches: (data: string, key: string) => boolean = (d, k) => d === k,
): TuneEvent {
  if (state.editing) {
    // Editing mode: pass through (enter/esc/backspace/printable only).
    if (matches(data, "enter") || matches(data, "escape") || matches(data, "backspace")) {
      return applyKey(state, matches(data, "enter") ? "enter" : matches(data, "escape") ? "escape" : "backspace");
    }
    return applyKey(state, data);
  }
  const norm =
    matches(data, "up") ? "up" :
    matches(data, "down") ? "down" :
    matches(data, "left") ? "left" :
    matches(data, "right") ? "right" :
    matches(data, "tab") ? "tab" :
    matches(data, "shift+tab") ? "shift+tab" :
    matches(data, "space") ? "space" :
    matches(data, "enter") ? "enter" :
    matches(data, "escape") ? "escape" :
    matches(data, "ctrl+c") ? "ctrl+c" :
    data;
  return applyKey(state, norm);
}

// ─── Renderer ───────────────────────────────────────────────────────────────

export interface TuneStyle {
  title: (s: string) => string;
  accent: (s: string) => string;
  dim: (s: string) => string;
  ok: (s: string) => string;
  warn: (s: string) => string;
}

export const PLAIN_STYLE: TuneStyle = {
  title: (s) => s,
  accent: (s) => s,
  dim: (s) => s,
  ok: (s) => s,
  warn: (s) => s,
};

export interface TuneScreenMeta {
  id: string;
  tier: string;
  loaded?: boolean;
  ctxWindow?: number;
  tags?: string[];
  /** ISO date the capabilities were last probed (catalog _meta). */
  probedAt?: string;
}

const LEGEND = "↑↓/tab move · ←→ toggle/nudge · enter edit · s save · q/esc cancel";

function fmtValue(f: TuneField, v: unknown): string {
  if (f.kind === "bool") return fmtBool(v);
  if (v === undefined) return "—";
  if (f.kind === "string") return `"${v}"`;
  return String(v);
}

/**
 * Render the full mask. Every line is guaranteed ≤ width (truncated).
 * Style is injected so the pure renderer is theme-free by default.
 */
export function renderTuneScreen(
  state: TuneScreenState,
  width: number,
  meta: TuneScreenMeta,
  style: TuneStyle = PLAIN_STYLE,
): string[] {
  const lines: string[] = [];

  const headerBits = [
    style.title(`Tune: ${meta.id}`),
    style.dim(`[${meta.tier}]`),
    style.dim(meta.loaded ? "● loaded" : "○ not loaded"),
  ].filter(Boolean);
  lines.push(truncate(headerBits.join("  "), width, style.title));

  // Details on their own line — one line gets cramped/truncated fast once
  // ctx + probe date + tags join the id.
  const detailBits = [
    meta.ctxWindow ? style.dim(`ctx ${meta.ctxWindow}`) : "",
    meta.probedAt ? style.dim(`last probe ${meta.probedAt.slice(0, 10)}`) : "",
    meta.tags && meta.tags.length > 0 ? style.dim(`tags: ${meta.tags.join(",")}`) : "",
  ].filter(Boolean);
  if (detailBits.length > 0) {
    lines.push(truncate(detailBits.join("   ·   "), width, style.dim));
  }

  let lastGroup = "";
  const labelW = Math.max(...TUNE_FIELDS.map((f) => f.label.length)) + 2;
  TUNE_FIELDS.forEach((f, i) => {
    if (f.group !== lastGroup) {
      lastGroup = f.group;
      lines.push(style.dim(`  ─ ${f.group} ─`));
    }
    const current = i === state.cursor;
    const v = getByPath(state.entry, f.path);
    const prefix = current ? style.accent("> ") : "  ";
    const label = style.accent(f.label.padEnd(labelW));
    let value: string;
    if (current && state.editing) {
      value = style.accent(`|${state.buffer}`) + style.accent("▌");
    } else if (f.path === "contextWindow" && v === undefined) {
      // Absent = no user cap — the server window stands. Show it instead of
      // a bare "—" (display-only; the field is written only if the user sets it).
      value = meta.ctxWindow ? style.dim(`— no cap (server ${meta.ctxWindow})`) : "—";
    } else {
      value = current ? style.accent(fmtValue(f, v)) : fmtValue(f, v);
    }
    lines.push(truncate(prefix + label + value, width, style.title));
  });

  const status = state.notice
    ? style.warn(`⚠ ${state.notice}`)
    : state.dirty
      ? style.ok("● edited — s to save")
      : style.ok("clean — s to save, q to cancel");
  lines.push(truncate(status, width, style.ok));
  lines.push(truncate(style.dim(LEGEND), width, style.dim));

  return lines;
}

/** ANSI-aware-enough truncation (plain + single-style lines only). */
function truncate(line: string, width: number, style: (s: string) => string): string {
  if (line.length <= width) return line;
  // Strip style if any (style wraps the whole line) then cut.
  let plain = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length > width) {
    plain = plain.slice(0, Math.max(0, width - 1)) + "…";
  }
  return style(plain);
}

// ─── pi adapter ─────────────────────────────────────────────────────────────

export interface TuneScreenCallbacks {
  /**
   * Write the entry (single sanctioned path). Return "ok" to close, or an
   * error string to stay open with the error shown in the status line.
   */
  onCommit: (entry: Record<string, unknown>) => "ok" | string;
  /** Close the screen (call the custom() done()). */
  onClose: (committed: boolean) => void;
}

export interface TuneScreenTuiLike {
  requestRender(): void;
}

/**
 * Build the component object for `ctx.ui.custom`. Structurally typed — the
 * plugin never imports pi's extension types here, keeping the module testable.
 *
 * `matches` should be pi-tui's `matchesKey`; pass undefined in tests.
 */
export function createTuneScreen(opts: {
  entry: Record<string, unknown>;
  meta: TuneScreenMeta;
  tui: TuneScreenTuiLike;
  style?: TuneStyle;
  callbacks: TuneScreenCallbacks;
  matches?: (data: string, key: string) => boolean;
}): {
  render(width: number): string[];
  handleInput(data: string): void;
  invalidate(): void;
} {
  const state = createTuneState(opts.entry);
  const style = opts.style ?? PLAIN_STYLE;
  let closed = false;

  return {
    render: (width: number) => renderTuneScreen(state, width, opts.meta, style),
    handleInput: (data: string) => {
      if (closed) return;
      const ev = applyRawKey(state, data, opts.matches);
      if (ev === "save") {
        const res = opts.callbacks.onCommit(state.entry);
        if (res === "ok") {
          closed = true;
          opts.callbacks.onClose(true);
          return;
        }
        state.notice = res;
      } else if (ev === "cancel") {
        closed = true;
        opts.callbacks.onClose(false);
        return;
      }
      opts.tui.requestRender();
    },
    invalidate: () => {},
  };
}
