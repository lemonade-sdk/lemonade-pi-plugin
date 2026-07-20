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

export function mapToProviderModel(m: LemonadeModelInfo) {
  const input: ("text" | "image")[] = ["text"];
  if (m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd")) {
    input.push("image");
  }
  const cfg = m.config ?? {};
  const contextWindow =
    (cfg["context_window"] as number) ?? (cfg["context_len"] as number) ?? 128000;
  const maxTokens =
    (cfg["max_new_tokens"] as number) ?? (cfg["max_tokens"] as number) ?? 4096;
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m.recipe),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}
