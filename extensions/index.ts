/**
 * @lemonade/lemonade-provider
 *
 * Pi.dev extension for Lemonade local LLM server.
 *
 * Integrates with Pi's built-in /login selector by registering Lemonade as a
 * custom provider with an oauth block. Picking "Lemonade" in /login runs the
 * login flow below, which:
 *   1. Discovers servers via Lemonade's UDP beacon (port 13305).
 *   2. Falls back to an HTTP port scan (8000, 1234, 9000, 8080).
 *   3. Lets the user confirm / pick / type a URL.
 *   4. Optionally collects an API key.
 *   5. Verifies, fetches the model list, re-registers the provider.
 *
 * Admin commands live under /lemonade (status, models, load, pull, etc.).
 */

import type { ExtensionAPI, PiCommandContext } from "../lib/types.js";
import { PROVIDER_ID, PROVIDER_LABEL } from "../lib/constants.js";
import { decodeCreds, encodeCreds } from "../lib/credentials.js";
import { readStoredPayload } from "../lib/admin.js";
import { registerAdminCommand } from "../lib/admin.js";
import { oauthLogin } from "../lib/oauth.js";
import { registerLemonadeProvider } from "../lib/provider.js";

export default async function lemonadeProvider(pi: ExtensionAPI): Promise<void> {
  const oauthBlock = {
    name: PROVIDER_LABEL,
    login: (callbacks: Parameters<typeof oauthLogin>[1]): ReturnType<typeof oauthLogin> =>
      oauthLogin(pi, callbacks, oauthBlock),
    refreshToken: async (creds: Awaited<ReturnType<typeof oauthLogin>>): Promise<Awaited<ReturnType<typeof oauthLogin>>> => {
      const payload = decodeCreds(creds);
      if (payload.baseUrl) {
        try {
          await registerLemonadeProvider(pi, payload, oauthBlock);
        } catch {
          // network blip — keep creds, retry on next refresh
        }
      }
      return encodeCreds(payload);
    },
    getApiKey: (creds: Awaited<ReturnType<typeof oauthLogin>>): string => {
      const payload = decodeCreds(creds);
      return payload.apiKey || "";
    },
  };

  // Initial stub registration so "Lemonade" appears in Pi's /login selector
  // even before the user has connected.
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_LABEL,
    baseUrl: "http://localhost:8000/v1",
    api: "openai-completions",
    models: [],
    oauth: oauthBlock,
  });

  // Best-effort: if Pi already has saved creds for us, re-register eagerly so
  // the model picker is populated without waiting for the next refresh tick.
  const stored = await readStoredPayload();
  if (stored?.baseUrl) {
    try {
      await registerLemonadeProvider(pi, stored, oauthBlock);
    } catch {
      // ignore — refreshToken will retry
    }
  }

  registerAdminCommand(pi, oauthBlock);
}
