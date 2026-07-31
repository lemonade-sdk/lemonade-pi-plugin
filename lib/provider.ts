/**
 * @lemonade/lemonade-provider
 *
 * Provider model mapping and (re-)registration.
 */

import type { ExtensionAPI, LemonadeModelInfo } from "./types.js";
import type { CredsPayload } from "./types.js";
import { PROVIDER_ID } from "./constants.js";
import { fetchModels } from "./http.js";
import { mapToProviderModel as mapFn } from "./models.js";

export { isReasoningModel, mapToProviderModel } from "./models.js";

// ─── Provider (re-)registration ─────────────────────────────────────────────

/**
 * Full provider registration: unregisters and re-registers with fresh model data.
 * Used on first connect and on session start.
 */
export async function registerLemonadeProvider(
  pi: ExtensionAPI,
  payload: CredsPayload | null,
  oauthBlock: unknown,
): Promise<number> {
  const baseUrl = payload?.baseUrl ?? "";
  let providerModels: ReturnType<typeof mapFn>[] = [];
  if (baseUrl) {
    const raw = await fetchModels(baseUrl, payload?.apiKey);
    providerModels = raw.map(mapFn);
  }

  try {
    pi.unregisterProvider(PROVIDER_ID);
  } catch {
    // not previously registered; ignore
  }

  const config: Record<string, unknown> = {
    name: payload?.serverName ? `Lemonade (${payload.serverName})` : "Lemonade",
    baseUrl: baseUrl ? `${baseUrl}/v1` : "http://localhost:8000/v1",
    api: "openai-completions",
    models: providerModels,
    oauth: oauthBlock,
  };
  if (payload?.apiKey) {
    config.headers = { Authorization: `Bearer ${payload.apiKey}` };
  }
  pi.registerProvider(PROVIDER_ID, config);
  return providerModels.length;
}
