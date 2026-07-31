/**
 * @lemonade/lemonade-provider
 *
 * OAuth credential encoding/decoding.
 */

import type { OAuthCredentials, CredsPayload } from "./types.js";
import { CREDS_TTL_MS } from "./constants.js";

export function encodeCreds(payload: CredsPayload): OAuthCredentials {
  return {
    refresh: JSON.stringify(payload),
    access: payload.apiKey,
    expires: Date.now() + CREDS_TTL_MS,
  };
}

export function decodeCreds(creds: OAuthCredentials): CredsPayload {
  try {
    const parsed = JSON.parse(creds.refresh ?? "");
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : (creds.access ?? ""),
      serverName: typeof parsed.serverName === "string" ? parsed.serverName : "Lemonade",
    };
  } catch {
    return { baseUrl: "", apiKey: creds.access ?? "", serverName: "Lemonade" };
  }
}
