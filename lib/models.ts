/**
 * @lemonade/lemonade-provider
 *
 * Model mapping: transforms Lemonade server model info into Pi provider shape.
 */

import type { LemonadeModelInfo } from "./types.js";

export function isReasoningModel(recipe: string | undefined): boolean {
  if (!recipe) return false;
  const r = recipe.toLowerCase();
  return ["qwq", "deepseek-r1", "r1", "o1", "o3", "think"].some((t) => r.includes(t));
}

// ─── Thinking-level support ─────────────────────────────────────────────────
//
// pi shows a thinking-level selector for models with `reasoning: true`.
// `thinkingLevelMap` maps each pi level to the wire value pi sends.
// A level mapped to `null` is hidden from the selector; `xhigh` only appears
// when it is explicitly mapped.
//
// Qwen3-style models behind vLLM (Lemonade's default LLM backend, and Nexus
// routers in front of it) accept thinking controls through the Jinja chat
// template via `chat_template_kwargs`:
//   { "enable_thinking": true/false, "reasoning_effort": "low|medium|high" }
//
// pi only honors configurable `chatTemplateKwargs` when
// `thinkingFormat === "chat-template"`. That format was added in pi-ai 0.80
// (pi 0.80+). With it, pi fills in per request:
//   - `{ "$var": "thinking.enabled" }` → true when a thinking level is
//     selected, false when it is off
//   - `{ "$var": "thinking.effort" }`  → the `thinkingLevelMap` value for the
//     selected level (omitted when off if `omitWhenOff` is set)
//
// This matters because vLLM silently ignores a top-level `reasoning_effort`
// (it is not an OpenAI API field) — effort must arrive inside the chat
// template kwargs or as `--default-chat-template-kwargs` at launch.
//
// Note: pi < 0.80 does not understand the `chat-template` format; on those
// versions the thinking level selector still appears (thanks to
// thinkingLevelMap) but pi cannot forward the level — update pi instead.

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface ThinkingSpec {
  /** Case-insensitive pattern tested against the model id and recipe. */
  match: RegExp;
  /** pi thinking level → wire value (null = hidden from the selector). */
  levels: Partial<Record<ThinkingLevel, string | null>>;
  /** Hard-disable value sent at `off`; null = leave the template default. */
  offValue: string | null;
}

const THINKING_SPECS: ThinkingSpec[] = [
  {
    // Qwen 3.8 (e.g. "Qwen/Qwen3.8-27B-FP8") — expose minimal/low/medium/high.
    // vLLM clamps reasoning_effort to its own supported set, so high is a
    // safe alias for xhigh.
    match: /qwen[-\s.]?3[-\s.]?8/i,
    levels: {
      off: "none",
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    },
    offValue: "none",
  },
];

export function matchThinkingSpec(m: LemonadeModelInfo): ThinkingSpec | undefined {
  const haystack = `${m.id} ${m.recipe ?? ""}`;
  return THINKING_SPECS.find((spec) => spec.match.test(haystack));
}

// ─── Provider model mapping ─────────────────────────────────────────────────

export function mapToProviderModel(m: LemonadeModelInfo) {
  const input: ("text" | "image")[] = ["text"];
  if (m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd")) {
    input.push("image");
  }
  const cfg = m.config ?? {};
  const recipeOpts = m.recipe_options ?? {};

  // Priority: loaded model's actual ctx_size > max_context_window > config fallback
  const contextWindow =
    (recipeOpts["ctx_size"] as number) ??
    (cfg["max_context_window"] as number) ??
    (cfg["context_window"] as number) ??
    (cfg["context_len"] as number) ??
    128000;
  const maxTokens =
    (cfg["max_new_tokens"] as number) ??
    (cfg["max_tokens"] as number) ??
    4096;
  const thinking = matchThinkingSpec(m);
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: thinking ? true : isReasoningModel(m.recipe),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // Thinking controls for models with a thinking spec. pi fills the
    // `chatTemplateKwargs` values from `thinkingLevelMap` per request when
    // `thinkingFormat` is `chat-template` (pi-ai >= 0.80), producing
    //   { "enable_thinking": <on/off>, "reasoning_effort": "<level>",
    //     "preserve_thinking": true }
    // — exactly what Qwen3-style models behind vLLM need.
    ...(thinking
      ? {
          thinkingLevelMap: thinking.levels,
          compat: {
            supportsDeveloperRole: false,
            thinkingFormat: "chat-template",
            chatTemplateKwargs: {
              enable_thinking: { $var: "thinking.enabled" },
              reasoning_effort: {
                $var: "thinking.effort",
                omitWhenOff: thinking.offValue === null,
              },
              preserve_thinking: true,
            },
          },
        }
      : {}),
  };
}
