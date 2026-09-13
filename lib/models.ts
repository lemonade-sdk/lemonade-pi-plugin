/**
 * @lemonade/lemonade-provider
 *
 * Model mapping: transforms Lemonade server model info into Pi provider shape.
 *
 * CAPABILITY MODEL (catalog-driven):
 *
 *   Catalogued model — an entry in the per-model catalog
 *   (lib/model-params.ts, user tier over plugin tier) is the SINGLE source
 *   of truth for capabilities: `reasoning`, `vision`, `disableReasoning`,
 *   `thinkingTokenBudgetField`, `maxTokens`. Absent fields fall back to pi
 *   defaults (no reasoning, text-only input). No name/label heuristics are
 *   applied to catalogued models — what is written is what pi sees.
 *
 *   Uncatalogued model — plain upstream behavior: recipe-keyword reasoning
 *   detection (qwq/deepseek-r1/r1/o1/o3/think), image input for
 *   category "image" / sd backends, server-config ceilings. To configure a
 *   model's capabilities explicitly, run `/lemonade tune <model>`.
 */

import type { LemonadeModelInfo } from "./types.js";
import { resolveModelEntry } from "./model-params.js";

/** Upstream recipe-keyword reasoning detection (baseline for uncatalogued models). */
export function isReasoningModel(recipe: string | undefined): boolean {
  if (!recipe) return false;
  const r = recipe.toLowerCase();
  return ["qwq", "deepseek-r1", "r1", "o1", "o3", "think"].some((t) => r.includes(t));
}

/**
 * Pi compatibility gate: a model can run a pi session only if it does chat
 * completions AND tool calling. Server-side labels are the single source of
 * truth (no name heuristics): other model classes (tts, image, 3d,
 * embeddings, transcription, audio-generation) and chat models missing the
 * tool-calling tag (e.g. untagged omni models) are excluded. Fix a
 * mis-tagged model at the source — the server recipe labels.
 */
export function isPiCompatible(m: Pick<LemonadeModelInfo, "id" | "labels">): boolean {
  const labels = m.labels ?? [];
  return labels.includes("chat") && labels.includes("tool-calling");
}

/**
 * Pi compatibility with escape hatch: LEMONADE_ALL_MODELS=1 shows every
 * server model (power users / testing non-chat models).
 */
export function isPiVisible(m: Pick<LemonadeModelInfo, "id" | "labels">): boolean {
  return process.env.LEMONADE_ALL_MODELS ? true : isPiCompatible(m);
}

/** Image-generation input: upstream category/backend check. */
function hasImageInput(m: LemonadeModelInfo): boolean {
  return m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd");
}

/**
 * Map Lemonade model info to Pi provider model shape.
 * Catalogued models get catalog capabilities; uncatalogued models get the
 * plain upstream baseline.
 */
export function mapToProviderModel(m: LemonadeModelInfo) {
  const cfg = m.config ?? {};

  // Context window priority: loaded model's actual ctx_size > model's
  // top-level max_context_window > model definition's context window > fallback.
  // A catalog `contextWindow` (user RAM-fit) caps it shrink-only — min(server, cap)
  // — and can never expand beyond what the server has actually allocated.
  const serverCtx =
    (m.recipe_options?.ctx_size as number) ??
    (m.max_context_window as number) ??
    (cfg["max_context_window"] as number) ??
    (cfg["context_window"] as number) ??
    (cfg["context_len"] as number) ??
    128000;

  const entry = resolveModelEntry(m.id);
  const ctxCap = entry?.contextWindow;
  const contextWindow =
    typeof ctxCap === "number" && ctxCap > 0 ? Math.min(serverCtx, ctxCap) : serverCtx;

  let input: ("text" | "image")[] = ["text"];
  if (hasImageInput(m)) input.push("image");

  let reasoning: boolean;
  let maxTokens: number;
  let compat: Record<string, unknown> | undefined;
  let disableReasoning: boolean | undefined;

  if (entry) {
    // ── Catalog-driven: the entry is the single source of truth ──
    reasoning = entry.reasoning === true && entry.disableReasoning !== true;
    if (entry.vision === true && !input.includes("image")) input.push("image");
    if (entry.disableReasoning === true) disableReasoning = true;

    maxTokens =
      typeof entry.maxTokens === "number" && entry.maxTokens > 0
        ? entry.maxTokens
        : ((cfg["max_new_tokens"] as number) ?? (cfg["max_tokens"] as number) ?? 4096);

    // Per-level thinking budget wire field — the only knob the llama.cpp
    // backend honors (verified; reasoning_effort / thinking_budget are
    // ignored). Default for catalogued reasoning models.
    if (reasoning) {
      compat = {
        ...(compat as Record<string, unknown> | undefined),
        thinkingTokenBudgetField:
          entry.thinkingTokenBudgetField ?? "thinking_budget_tokens",
      };
    }
  } else {
    // ── Uncatalogued: plain upstream behavior (no heuristics beyond recipe) ──
    reasoning = isReasoningModel(m.recipe);
    maxTokens =
      (cfg["max_new_tokens"] as number) ?? (cfg["max_tokens"] as number) ?? 4096;
  }

  const result: Record<string, unknown> = {
    id: m.id,
    name: m.name || m.id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };

  if (compat) result.compat = compat;
  if (disableReasoning) (result as any).disable_reasoning = true;

  return result as ReturnType<typeof mapToProviderModel>;
}
