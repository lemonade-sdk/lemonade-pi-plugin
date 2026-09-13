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
import { syncModelStore } from "../lib/sync-store.js";
import { seedModelEntry, isCatalogued } from "../lib/model-params.js";
import { tuneModelPayload, envFlag } from "../lib/payload-tuning.js";
import { writePayloadDebugLog } from "../lib/payload-debug.js";

export default async function lemonadeProvider(pi: ExtensionAPI): Promise<void> {
  // Model-store sync args (kept current on every sync path) — the
  // debounced re-sync after a first-use seed uses these.
  let syncArgs: { baseUrl: string; apiKey: string } | undefined;
  let resyncTimer: ReturnType<typeof setTimeout> | undefined;
  let resyncInFlight = false;
  const doSync = (baseUrl: string, apiKey: string): void => {
    syncArgs = { baseUrl, apiKey };
    syncModelStore(baseUrl, apiKey);
  };
  // Debounced + serialized models-store re-sync. Needed after a first-use
  // seed: the store carries the per-model reasoning flag that decides
  // which thinking levels pi offers — a mid-session seed must refresh it,
  // or the new model sits "off only" until the next pi start (the exact
  // 2026-09-08 symptom). Worst case pi's per-process store cache is
  // stale until restart — never wrong, just delayed.
  const scheduleStoreResync = (): void => {
    if (resyncTimer || resyncInFlight || !syncArgs) return;
    resyncTimer = setTimeout(() => {
      resyncTimer = undefined;
      if (resyncInFlight || !syncArgs) return;
      resyncInFlight = true;
      syncModelStore(syncArgs.baseUrl, syncArgs.apiKey).finally(() => {
        resyncInFlight = false;
      });
    }, 1000);
    resyncTimer.unref?.(); // never hold the process open for a re-sync
  };

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
        // Keep models-store.json in sync during token refresh too.
        doSync(payload.baseUrl, payload.apiKey);
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
      // Cold-start self-heal: pi's in-memory provider registry may hold a
      // STALE mapping for a model that was registered before its catalog
      // entry existed (uncatalogued → reasoning=false via recipe keywords)
      // — which clamps the session thinking level to "off" until restart.
      // Re-registering with the catalog present re-maps every model from
      // the live server; registerProvider merges defined values over the
      // previous registration, so this replaces the stale capabilities.
      // Only fires when at least one served model is now catalogued (the
      // normal case) — a genuinely uncatalogued fleet keeps default pi
      // behavior, byte-identical.
      try {
        const { fetchModels } = await import("../lib/http.js");
        const raw = await fetchModels(stored.baseUrl, stored.apiKey);
        if (raw.some((m) => isCatalogued(m.id))) {
          console.log(
            "[lemonade] cold-start: catalog present for served models — re-registering with live capabilities",
          );
          await registerLemonadeProvider(pi, stored, oauthBlock);
        }
      } catch {
        // best-effort — the first request's seed + resync covers it
      }
    } catch {
      // ignore — refreshToken will retry
    }
    // Keep models-store.json in sync so subprocesses and subagents can
    // resolve lemonade models with correct context sizes.
    doSync(stored.baseUrl, stored.apiKey);
  }

  registerAdminCommand(pi, oauthBlock);

  // Model-driven payload tuning (P2 budgets, P3 sampling, P5 off-level wire
  // off-switch). Runs on pi's `before_provider_request` event: the handler
  // receives the FINAL wire payload and its return value replaces it. What
  // is tuned is decided by the per-model catalog (user tier over plugin
  // tier) — uncatalogued models pass through with default pi behavior,
  // byte-identical. All tuning stays in this plugin (mainstream pi is
  // untouched). Env: LEMONADE_PAYLOAD_TUNING (master switch),
  // LEMONADE_SAMPLING_PROFILE. LEMONADE_PAYLOAD_DEBUG=1: log the payload as
  // left by this handler for ALL models to /tmp/pi-payload-capture.jsonl.
  pi.on("before_provider_request", (event: { payload?: Record<string, unknown> }, ctx?: { thinkingLevel?: string }) => {
    const payload = event?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    // First-use seed: a RECOGNIZED model (bundled examples) not yet in the
    // user/plugin catalog is added when first actually requested — the
    // wire payload is the only reliable "current model" signal (covers
    // cold start, resumed sessions, mid-stack switches alike). Idempotent
    // once present; a failure never breaks the request. A fresh seed also
    // refreshes models-store.json (reasoning flag → thinking levels).
    if (typeof payload.model === "string") {
      try {
        if (seedModelEntry(payload.model) === "seeded") scheduleStoreResync();
      } catch {
        // seeding is best-effort
      }
    }
    let tuned: Record<string, unknown> | undefined;
    try {
      tuned = tuneModelPayload(payload, { thinkingLevel: ctx?.thinkingLevel });
    } catch {
      // Tuning must never break a request — pass through untouched.
      tuned = undefined;
    }
    if (envFlag("LEMONADE_PAYLOAD_DEBUG", false)) {
      writePayloadDebugLog(tuned ?? payload);
    }
    return tuned;
  });

}
