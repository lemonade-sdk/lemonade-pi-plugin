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
    const res = await fetch(`${baseUrl}/api/v1/models`, {
      headers: authHeaders(apiKey),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: LemonadeModelInfo[] };
    return Array.isArray(data?.data) ? data.data : [];
  } catch {
    return [];
  }
}
