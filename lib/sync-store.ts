/**
 * @lemonade/lemonade-provider
 *
 * Keep models-store.json in sync so Pi subprocesses and subagents can
 * resolve lemonade models with correct context sizes without making a
 * network call.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LemonadeModelInfo } from "./types.js";
import { fetchModels } from "./http.js";
import { buildBaseUrl } from "./url-helpers.js";
import { mapToProviderModel } from "./models.js";

const STORE_PATH = path.join(os.homedir(), ".pi", "agent", "models-store.json");

/**
 * Sync models-store.json with the current Lemonade model list.
 * Reads from the API and maps models using the same logic as the provider
 * registration, so subprocesses and subagents see the same contextWindow
 * and maxTokens values.
 *
 * Only call this when a Lemonade server is known (stored credentials or an
 * explicit login) — there is no anonymous fallback.
 */
export async function syncModelStore(baseUrl: string, apiKey?: string): Promise<void> {
  const base = buildBaseUrl(baseUrl);
  const modelsUrl = `${base}/api/v1/models`;

  try {
    const res = await fetch(modelsUrl, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(
        `[lemonade] models-store sync: ${modelsUrl} → HTTP ${res.status} (store not updated)`,
      );
      return;
    }
    const data = await res.json() as { data?: LemonadeModelInfo[] };
    const models = data?.data || [];

    const mapped = models.map((m) => mapToProviderModel(m));

    try {
      const existing = JSON.parse(
        await fs.readFile(STORE_PATH, "utf8"),
      ) as Record<string, unknown>;
      existing["lemonade"] = {
        models: mapped,
        checkedAt: Date.now(),
        lastModified: Date.now(),
      };
      await fs.writeFile(STORE_PATH, JSON.stringify(existing, null, 2));
    } catch {
      // non-critical — subprocesses still fall back to provider at runtime
    }
  } catch (err) {
    console.warn(
      `[lemonade] models-store sync failed for ${modelsUrl}: ${String(err)} (store not updated)`,
    );
  }
}
