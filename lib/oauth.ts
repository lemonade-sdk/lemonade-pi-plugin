/**
 * @lemonade/lemonade-provider
 *
 * OAuth login flow — runs when user picks "Lemonade" in /login.
 * Coordinates discovery, user prompts, verification, and provider registration.
 */

import type { ExtensionAPI, OAuthCredentials, OAuthLoginCallbacks } from "./types.js";
import { buildBaseUrl } from "./url-helpers.js";
import { checkHealth } from "./http.js";
import { discoverServers } from "./discovery.js";
import { registerLemonadeProvider } from "./provider.js";
import { encodeCreds } from "./credentials.js";

export async function oauthLogin(
  pi: ExtensionAPI,
  callbacks: OAuthLoginCallbacks,
  oauthBlock: unknown,
): Promise<OAuthCredentials> {
  const discovered = await discoverServers(2500);

  let baseUrl = "";
  let serverName = "Lemonade";

  if (discovered.length === 0) {
    const input = await callbacks.onPrompt({
      message:
        "No Lemonade server found via UDP beacon (port 13305) or local port scan.\n" +
        "Enter Lemonade server URL (press Enter for http://localhost:8000):",
    });
    const trimmed = input.trim();
    baseUrl = trimmed ? buildBaseUrl(trimmed) : "http://localhost:8000";
  } else if (discovered.length === 1) {
    const only = discovered[0];
    const confirm = await callbacks.onPrompt({
      message:
        `Found Lemonade server: ${only.hostname} at ${only.baseUrl}\n` +
        `Press Enter to use this, or type a different URL:`,
    });
    const trimmed = confirm.trim();
    if (trimmed) {
      baseUrl = buildBaseUrl(trimmed);
      serverName = "Lemonade";
    } else {
      baseUrl = only.baseUrl;
      serverName = only.hostname;
    }
  } else {
    let menu = `Found ${discovered.length} Lemonade servers:\n`;
    discovered.forEach((d, i) => {
      menu += `  [${i + 1}] ${d.hostname} — ${d.baseUrl}\n`;
    });
    menu += "Enter number to select, or type a custom URL:";
    const choice = (await callbacks.onPrompt({ message: menu })).trim();
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= discovered.length) {
      baseUrl = discovered[num - 1].baseUrl;
      serverName = discovered[num - 1].hostname;
    } else if (choice) {
      baseUrl = buildBaseUrl(choice);
      serverName = "Lemonade";
    } else {
      baseUrl = discovered[0].baseUrl;
      serverName = discovered[0].hostname;
    }
  }

  const apiKeyInput = await callbacks.onPrompt({
    message:
      "Enter API key (optional — press Enter to skip if your server doesn't require one):",
  });
  const apiKey = apiKeyInput.trim();

  const health = await checkHealth(baseUrl, apiKey || undefined);
  if (!health) {
    throw new Error(
      `Cannot reach Lemonade at ${baseUrl}. Check that the server is running` +
        (apiKey ? " and that the API key is correct." : "") +
        ".",
    );
  }

  const payload = {
    baseUrl,
    apiKey,
    serverName: `${serverName} v${health.version}`,
  };
  await registerLemonadeProvider(pi, payload, oauthBlock);

  return encodeCreds(payload);
}
