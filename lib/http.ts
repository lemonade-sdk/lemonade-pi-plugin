/**
 * @lemonade/lemonade-provider
 *
 * HTTP calls against the Lemonade server API.
 */

import type { LemonadeHealth, LemonadeModelInfo } from "./types.js";
import { authHeaders } from "./url-helpers.js";

export async function checkHealth(baseUrl: string, apiKey?: string): Promise<LemonadeHealth | null> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as LemonadeHealth;
  } catch {
    return null;
  }
}

export async function fetchModels(baseUrl: string, apiKey?: string): Promise<LemonadeModelInfo[]> {
  try {
    const [modelsRes, healthRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/models`, {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(10000),
      }),
      fetch(`${baseUrl}/api/v1/health`, {
        headers: authHeaders(apiKey),
        signal: AbortSignal.timeout(3000),
      }),
    ]);

    if (!modelsRes.ok) return [];
    const raw = (await modelsRes.json()) as { data?: unknown[] };
    const items = Array.isArray(raw?.data) ? raw.data : [];

    // Build loaded model map from health endpoint
    let loadedCtxMap = new Map<string, number>();
    let loadedBackendUrl = new Map<string, string>();
    if (healthRes.ok) {
      const health = await healthRes.json() as LemonadeHealth;
      for (const bm of health.all_models_loaded) {
        loadedCtxMap.set(bm.model_name, bm.recipe_options?.ctx_size ?? bm.max_context_window);
        loadedBackendUrl.set(bm.model_name, bm.backend_url);
      }
    }

    // Map API response into LemonadeModelInfo
    return items.map((item) => {
      const m = item as Record<string, unknown>;
      const modelName = String(m.id ?? "");
      const loaded = loadedCtxMap.has(modelName);

      return {
        id: modelName,
        name: typeof m.name === "string" ? m.name : undefined,
        category: typeof m.category === "string" ? m.category : undefined,
        backend: typeof m.backend === "string" ? m.backend : undefined,
        recipe: typeof m.recipe === "string" ? m.recipe : undefined,
        loaded,
        size: typeof m.size === "number" ? m.size : undefined,
        max_context_window: typeof m.max_context_window === "number" ? m.max_context_window : undefined,
        recipe_options: m.recipe_options && typeof m.recipe_options === "object"
          ? m.recipe_options as LemonadeModelInfo["recipe_options"]
          : undefined,
        backend_url: loadedBackendUrl.get(modelName),
      } as LemonadeModelInfo;
    });
  } catch {
    return [];
  }
}
