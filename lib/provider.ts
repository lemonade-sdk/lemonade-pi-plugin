/**
 * @lemonade/lemonade-provider
 *
 * Provider model mapping and (re-)registration.
 */

import type { ExtensionAPI, LemonadeModelInfo } from "./types.js";
import type { CredsPayload } from "./types.js";
import { PROVIDER_ID } from "./constants.js";
import { fetchModels } from "./http.js";
import { mapToProviderModel as mapFn, isPiVisible } from "./models.js";

export { isReasoningModel, isPiCompatible, isPiVisible, mapToProviderModel } from "./models.js";

/**
 * Latest FULL server model list, captured at provider registration. Served
 * to /lemonade argument completion (synchronous by contract — it cannot
 * fetch live); undefined until the first registration fetch succeeds.
 */
let cachedServerModels: LemonadeModelInfo[] | undefined;
export function getCachedServerModels(): LemonadeModelInfo[] | undefined {
  return cachedServerModels;
}

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
    cachedServerModels = raw;
    // Only chat + tool-calling models are usable in pi; non-chat classes
    // (tts/image/3d/embeddings/transcription) never reach the picker.
    providerModels = raw.filter(isPiVisible).map(mapFn);
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
    auth_type: "api-key", // servers with an API key authenticate via Bearer header
    models: providerModels,
    oauth: oauthBlock,
  };
  if (payload?.apiKey) {
    config.headers = { Authorization: `Bearer ${payload.apiKey}` };
  }
  pi.registerProvider(PROVIDER_ID, config);
  return providerModels.length;
}
