/**
 * @lemonade/lemonade-provider
 *
 * /lemonade admin command: status, models, load, unload, pull, delete, refresh, discover.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, OAuthCredentials, PiCommandContext } from "./types.js";
import { PROVIDER_ID } from "./constants.js";
import { decodeCreds } from "./credentials.js";
import { checkHealth, fetchModels } from "./http.js";
import { registerLemonadeProvider, getCachedServerModels } from "./provider.js";
import { isPiVisible } from "./models.js";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { syncModelStore } from "./sync-store.js";
import { discoverViaBeacon, discoverViaHttp } from "./discovery.js";
import { fmtHealth } from "./health.js";
import { changeModelContext } from "./change-ctx.js";
import { probeThinking, probeVision, buildTunedEntry, ggufBackfillNeeded } from "./model-probe.js";
import type { ThinkingProbeResult, VisionProbeResult, TunedEntryMeta } from "./model-probe.js";
import { fetchGgufParams } from "./gguf-params.js";
import {
  readPluginParams,
  readUserParams,
  upsertUserParamsEntry,
  userParamsPath,
  type ModelParamsEntry,
} from "./model-params.js";
import {
  renderEntryOverview,
  tunePickerOptions,
} from "./tune-ui.js";
import {
  createTuneScreen,
  type TuneStyle,
} from "./tune-screen.js";
import { matchesKey } from "@earendil-works/pi-tui";

// ─── Theme wiring for the tune mask ─────────────────────────────────────────
// (degrades to plain text when absent)
export function tuneThemeStyle(theme: { fg?: (color: string, text: string) => string } | undefined): TuneStyle {
  // theme.fg is a prototype method that reads `this.fgColors` — it must stay
  // bound to `theme`; detaching it (const fg = theme.fg) makes `this` undefined
  // at render time and crashes the TUI with "reading 'fgColors'".
  const fg = theme?.fg ? (c: string, s: string) => theme.fg!(c, s) : (_c: string, s: string) => s;
  return {
    title: (s) => fg("accent", s),
    accent: (s) => fg("accent", s),
    dim: (s) => fg("dim", s),
    ok: (s) => fg("success", s),
    warn: (s) => fg("warning", s),
  };
}

// ─── /lemonade argument completion ─────────────────────────────────────────

const LEMONADE_SUBCOMMANDS = [
  "status",
  "models",
  "list",
  "health",
  "load",
  "unload",
  "pull",
  "delete",
  "refresh",
  "change-ctx",
  "tune",
];

/**
 * Argument completion for /lemonade: subcommands first, then (for `tune`)
 * model ids from the latest provider-registration fetch. Synchronous by pi
 * contract — served from the registration cache (models param), never a live
 * fetch. Pi-visible models are the default completion set; any other server
 * model can still be typed explicitly.
 */
export function lemonadeCompletions(
  prefix: string,
  models: { id: string; labels?: string[] }[] | undefined,
): AutocompleteItem[] | null {
  const tokens = prefix.trim().split(/\s+/).filter(Boolean);
  const last = tokens.length > 0 ? tokens[tokens.length - 1].toLowerCase() : "";
  // Model-id context: "tune <partial>" — including the cursor right after
  // the trailing space ("tune ").
  const inTuneArgs =
    (tokens.length === 2 && tokens[0].toLowerCase() === "tune") ||
    (tokens.length === 1 && tokens[0].toLowerCase() === "tune" && /\s$/.test(prefix));
  if (inTuneArgs) {
    // pi replaces the ENTIRE argument prefix with item.value — so the value
    // must carry the "tune " prefix back, or selecting a model would drop
    // the subcommand and leave "/lemonade <id>" (wrong syntax).
    // The match tail is the raw text after the FINAL space — for "tune "
    // that's "" (match every model), not the "tune" subcommand token.
    const lastArg = prefix.slice(prefix.lastIndexOf(" ") + 1).toLowerCase();
    const items = (models ?? [])
      .filter((m) => isPiVisible(m))
      .map((m) => m.id)
      .filter((id) => id.toLowerCase().startsWith(lastArg))
      .map((id) => ({ value: `tune ${id}`, label: id }));
    return items.length > 0 ? items : null;
  }
  if (tokens.length <= 1) {
    const items = LEMONADE_SUBCOMMANDS.filter((c) => c.startsWith(last)).map((v) => ({ value: v, label: v }));
    return items.length > 0 ? items : null;
  }
  return null;
}

// ─── Format helpers ─────────────────────────────────────────────────────────

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

// ─── Credential reading ─────────────────────────────────────────────────────

/**
 * Best-effort: read Pi's persisted OAuth credentials so the admin command
 * works without making a network call to the OAuth flow. The on-disk format
 * is undocumented; we try a couple of reasonable shapes.
 */
export async function readStoredPayload(): Promise<{
  baseUrl: string;
  apiKey: string;
  serverName: string;
} | null> {
  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    const raw = await fs.readFile(authPath, "utf8");
    const data = JSON.parse(raw);
    const candidates: unknown[] = [
      data?.[PROVIDER_ID],
      data?.providers?.[PROVIDER_ID],
      data?.oauth?.[PROVIDER_ID],
    ];
    for (const c of candidates) {
      if (
        c &&
        typeof c === "object" &&
        typeof (c as OAuthCredentials).refresh === "string"
      ) {
        return decodeCreds(c as OAuthCredentials);
      }
    }
  } catch {
    // no auth.json yet, or unreadable
  }
  return null;
}

// ─── Admin command registration ─────────────────────────────────────────────

export function registerAdminCommand(pi: ExtensionAPI, oauthBlock: unknown): void {
  pi.registerCommand("lemonade", {
    description: "Lemonade server administration (status, models, load/pull/delete)",
    getArgumentCompletions: (prefix: string) => lemonadeCompletions(prefix, getCachedServerModels()),
    handler: async (args: string, ctx: PiCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1);

      if (cmd === "" || cmd === "help") {
        ctx.ui.notify(
          "/lemonade <command>\n" +
            "  status             — server health (simple)\n" +
            "  health             — server health (rich, detailed)\n" +
            "  models             — list models\n" +
            "  load <id>          — load a model into memory\n" +
            "  unload [id]        — unload a model (or all if no id)\n" +
            "  pull <id>          — download a model\n" +
            "  delete <id>        — remove a model from disk\n" +
            "  refresh            — re-fetch model list and re-register provider\n" +
            "  discover           — UDP beacon + HTTP port scan\n" +
            "  change-ctx <ctx_size> [model] — change context size for loaded model\n" +
            "  tune               — interactive picker over server models (catalog status)\n" +
            "  tune <id>          — probe a model and interactively edit its catalog entry\n" +
            "  tune <id> --json   — probe, print the raw JSON entry only (no write)\n" +
            "  tune <id> --yes    — probe and write without the editor\n" +
            "  tune <id> --no-probe — skip probing, keep catalog capabilities\n" +
            "                     (tune is slow when the model is not loaded)",
          "info",
        );
        return;
      }

      if (cmd === "discover") {
        ctx.ui.notify("Scanning UDP beacons (3s) + local port fallback…", "info");
        const beacons = await discoverViaBeacon(3000, /*localOnly=*/ false);
        const http = beacons.length === 0 ? await discoverViaHttp() : [];
        const all = [...beacons, ...http];
        if (all.length === 0) {
          ctx.ui.notify("No Lemonade servers found.", "warning");
          return;
        }
        let msg = `Found ${all.length} server(s):\n`;
        for (const s of all) msg += `  • ${s.hostname} — ${s.baseUrl}\n`;
        ctx.ui.notify(msg, "info");
        return;
      }

      const payload = await readStoredPayload();
      if (!payload?.baseUrl) {
        ctx.ui.notify(
          "Not connected to Lemonade. Run /login and pick Lemonade.",
          "warning",
        );
        return;
      }
      const baseUrl = payload.baseUrl;
      const apiKey = payload.apiKey || undefined;

      switch (cmd) {
        // ── health (rich formatter) ───────────────────────────────────────
        case "health": {
          const h = await checkHealth(baseUrl, apiKey);
          if (!h) {
            ctx.ui.notify(`Cannot reach Lemonade at ${baseUrl}`, "error");
            return;
          }
          ctx.ui.notify(fmtHealth(h), "info");
          return;
        }

        case "status": {
          const h = await checkHealth(baseUrl, apiKey);
          if (!h) {
            ctx.ui.notify(`Cannot reach ${baseUrl}`, "error");
            return;
          }
          ctx.ui.notify(
            `Lemonade v${h.version} @ ${baseUrl}\n` +
              `Status: ${h.status}\n` +
              `Loaded: ${h.model_loaded ?? "(none)"}\n` +
              `All loaded: ${(h.all_models_loaded ?? []).join(", ") || "(none)"}` +
              (h.websocket_port ? `\nWebSocket port: ${h.websocket_port}` : ""),
            "info",
          );
          return;
        }

        case "models":
        case "list": {
          const models = await fetchModels(baseUrl, apiKey);
          if (models.length === 0) {
            ctx.ui.notify("No models found.", "warning");
            return;
          }
          let out = `${models.length} model(s):\n`;
          for (const m of models) {
            const status = m.loaded ? "●" : "○";
            const size = m.size ? ` (${formatBytes(m.size)})` : "";
            out += `  ${status} ${m.name || m.id}${size}\n`;
            const parts: string[] = [];
            if (m.recipe) parts.push(`recipe: ${m.recipe}`);
            const ctxSize = m.recipe_options?.ctx_size;
            if (ctxSize) parts.push(`ctx: ${ctxSize.toLocaleString()}`);
            if (m.max_context_window) parts.push(`max: ${m.max_context_window.toLocaleString()}`);
            if (parts.length) out += `      ${parts.join(", ")}\n`;
          }
          ctx.ui.notify(out, "info");
          return;
        }

        case "load": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade load <model_id>", "warning");
            return;
          }
          ctx.ui.notify(`Loading ${id}…`, "info");
          await postModelOp(ctx, `${baseUrl}/api/v1/load`, apiKey, { model_name: id }, "load");
          return;
        }

        case "unload": {
          const id = rest[0];
          ctx.ui.notify(id ? `Unloading ${id}…` : "Unloading all models…", "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/unload`,
            apiKey,
            id ? { model_name: id } : {},
            "unload",
          );
          return;
        }

        case "pull": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade pull <model_id>", "warning");
            return;
          }
          ctx.ui.notify(`Pulling ${id} (this may take a while)…`, "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/pull`,
            apiKey,
            { model_name: id },
            "pull",
          );
          return;
        }

        case "delete": {
          const id = rest[0];
          if (!id) {
            ctx.ui.notify("Usage: /lemonade delete <model_id>", "warning");
            return;
          }
          ctx.ui.notify(`Deleting ${id} from disk…`, "info");
          await postModelOp(
            ctx,
            `${baseUrl}/api/v1/delete`,
            apiKey,
            { model_name: id },
            "delete",
          );
          return;
        }

        case "refresh": {
          const count = await registerLemonadeProvider(pi, payload, oauthBlock);
          syncModelStore(payload.baseUrl, payload.apiKey);
          ctx.ui.notify(`Re-synced: ${count} models registered.`, "info");
          return;
        }

        // ── change-ctx (change context size for loaded model) ─────────────
        case "change-ctx": {
          // Parse: /lemonade change-ctx <ctx_size> [model_name]
          const ctxSizeStr = rest[0];
          const targetModelName = rest[1] ?? null;

          if (!ctxSizeStr) {
            ctx.ui.notify(
              `Usage: /lemonade change-ctx <ctx_size> [model_name]\n` +
              `  <ctx_size>      — new context size (required)\n` +
              `  [model_name]    — optional (uses first loaded model if omitted)\n\n` +
              `  Supported formats: 32768, 32k, 64k, 128k, 1m, 2m, etc.\n` +
              `  (k = ×1024, m = ×1048576, plain number = exact tokens)\n` +
              `  Minimum: 32768 tokens (32k)\n\n` +
              `  Examples: /lemonade change-ctx 64k\n` +
              `            /lemonade change-ctx 128k\n` +
              `            /lemonade change-ctx 131072\n` +
              `            /lemonade change-ctx 1m Qwen3.6-35B-A3B-GGUF`,
              "warning",
            );
            return;
          }

          // Parse context size string (supports: "32768", "32k", "1m", etc.)
          function parseCtxSize(input: string, maxVal: number): number | null {
            const normalized = input.trim().toLowerCase();
            let rawNumber: number;

            if (normalized.endsWith("k")) {
              rawNumber = parseFloat(normalized.slice(0, -1));
              if (isNaN(rawNumber)) return null;
              rawNumber = Math.round(rawNumber * 1024);
            } else if (normalized.endsWith("m")) {
              rawNumber = parseFloat(normalized.slice(0, -1));
              if (isNaN(rawNumber)) return null;
              rawNumber = Math.round(rawNumber * 1024 * 1024);
            } else {
              rawNumber = parseInt(normalized, 10);
              if (isNaN(rawNumber) || rawNumber < 0) return null;
            }

            if (rawNumber <= 0) return null;
            return Math.min(rawNumber, maxVal);
          }

          // Read health to discover loaded models & limits
          const health = await checkHealth(baseUrl, apiKey);
          if (!health) {
            ctx.ui.notify(`Cannot reach Lemonade at ${baseUrl}`, "error");
            return;
          }

          if (health.all_models_loaded.length === 0) {
            ctx.ui.notify(
              "No models loaded. Load one first with /lemonade load.",
              "warning",
            );
            return;
          }

          const MIN_CTX = 32 * 1024; // 32k
          let targetModel: (typeof health.all_models_loaded)[0];

          if (targetModelName) {
            targetModel = health.all_models_loaded.find(
              (bm) => bm.model_name === targetModelName || bm.model_name.includes(targetModelName),
            );
            if (!targetModel) {
              const loadedNames = health.all_models_loaded.map((m) => m.model_name).join(", ");
              ctx.ui.notify(
                `Model "${targetModelName}" not found among loaded models.\n` +
                `Loaded: ${loadedNames || "(none)"}`,
                "error",
              );
              return;
            }
          } else {
            targetModel = health.all_models_loaded[0];
          }

          const currentCtx = targetModel.recipe_options?.ctx_size ?? 0;
          const maxCtx = targetModel.max_context_window;

          ctx.ui.notify(
            `Model:          ${targetModel.model_name}\n` +
              `Current ctx: ${currentCtx.toLocaleString()} tokens\n` +
              `Minimum ctx: ${MIN_CTX.toLocaleString()} tokens (32k)\n` +
              `Maximum ctx: ${maxCtx.toLocaleString()} tokens`,
            "info",
          );

          const newCtxSize = parseCtxSize(ctxSizeStr, maxCtx);
          if (newCtxSize === null) {
            ctx.ui.notify(`Invalid ctx_size: "${ctxSizeStr}". Use a positive number or k/m (e.g. 32k, 1m).`, "error");
            return;
          }

          if (newCtxSize < MIN_CTX) {
            ctx.ui.notify(
              `Required value ${newCtxSize.toLocaleString()} is below minimum (${MIN_CTX.toLocaleString()} / 32k).\n` +
              `Using ${MIN_CTX.toLocaleString()} (32k) instead.`,
              "warning",
            );
          }

          const finalCtx = Math.max(newCtxSize, MIN_CTX);

          if (finalCtx === currentCtx) {
            ctx.ui.notify(
              `ctx_size is already ${finalCtx.toLocaleString()}. No changes needed.`,
              "info",
            );
            return;
          }

          ctx.ui.notify(`Applying ctx_size=${finalCtx.toLocaleString()} to ${targetModel.model_name}…\n(Unload + reload with save_options)`, "info");

          const result = await changeModelContext(baseUrl, apiKey, targetModel.model_name, finalCtx);
          if (!result.success) {
            ctx.ui.notify(result.error ?? "Failed to change ctx_size.", "error");
            return;
          }

          ctx.ui.notify(
            `✓ ctx_size changed: ${currentCtx.toLocaleString()} → ${finalCtx.toLocaleString()} tokens\n` +
              `Updating metadata…`,
            "info",
          );

          // Re-sync provider and models-store to update contextWindow
          await registerLemonadeProvider(pi, payload, oauthBlock);
          syncModelStore(payload.baseUrl, payload.apiKey);
          ctx.ui.notify("Provider re-registered with new ctx.", "info");
          return;
        }

        // ── tune (probe capabilities + GGUF metadata → catalog entry) ────
        case "tune": {
          const flags = rest.filter((a) => a.startsWith("--"));
          let id = rest.find((a) => !a.startsWith("--"));

          const models = await fetchModels(baseUrl, apiKey);

          // No id → interactive picker: one compact row per model with
          // catalog tier (user / plugin / not in model-params.json).
          if (!id) {
            const opts = tunePickerOptions(
              models.map((m) => ({ id: m.id, loaded: m.loaded, labels: m.labels })),
              { user: readUserParams(), plugin: readPluginParams() },
            );
            const pick = await ctx.ui.select(
              "Tune which model? (Esc cancels)",
              opts.map((o) => o.label).concat("cancel"),
            );
            const chosen = pick ? opts.find((o) => o.label === pick) : undefined;
            if (!chosen) {
              ctx.ui.notify("tune cancelled — nothing probed or written.", "info");
              return;
            }
            id = chosen.id;
          }

          const model = models.find((m) => m.id === id || m.name === id);
          if (!model) {
            const known = models.map((m) => m.id).join(", ");
            ctx.ui.notify(`Model "${id}" not found on server.\nKnown: ${known}`, "error");
            return;
          }

          const labels = (model.labels ?? []).join(", ") || "(none)";
          const existing = readUserParams()?.[model.id];
          const prevMeta = (existing?._meta ?? undefined) as TunedEntryMeta | undefined;
          const probedAt = prevMeta?.probedAt;
          ctx.ui.notify(
            `Tuning ${model.id}\n` +
              `  server says: recipe=${model.recipe ?? "?"} labels=[${labels}]\n` +
              (existing
                ? `  catalog: user-tier entry${probedAt ? ` (probed ${probedAt.slice(0, 10)})` : ""}`
                : `  catalog: not in model-params (fresh entry)`),
            "info",
          );

          // Already catalogued → probing is optional (slow: the model may
          // have to load). Ask; --no-probe skips without asking, --yes keeps
          // the historic probe-then-write contract.
          let doProbe = !flags.includes("--no-probe");
          if (existing && doProbe) {
            const choice = await ctx.ui.select(
              `${model.id} is already in the catalog. Re-probe against the live server? (slow — may load the model)`,
              ["re-probe — refresh capabilities", "skip — keep catalog entry as-is"],
            );
            if (!choice) {
              ctx.ui.notify("Tune cancelled — nothing written.", "info");
              return;
            }
            doProbe = choice.startsWith("re-probe");
          }

          let thinking: ThinkingProbeResult | undefined;
          let vision: VisionProbeResult | undefined;
          if (doProbe) {
            ctx.ui.notify(`Probing the live server (may take minutes if the model must load)…`, "info");

            ctx.ui.notify(`  probing thinking (2 budgeted requests)…`, "info");
            thinking = await probeThinking(baseUrl, apiKey, model.id);
            if (thinking.error) {
              ctx.ui.notify(`  thinking probe failed: ${thinking.error}`, "warning");
            } else {
              ctx.ui.notify(
                `  thinking: emits=${thinking.emitsReasoning} honorsBudget=${thinking.honorsBudget}` +
                  ` (reasoning chars: small=${thinking.reasoningCharsSmall}, large=${thinking.reasoningCharsLarge})`,
                "info",
              );
            }

            ctx.ui.notify(`  probing vision (image request)…`, "info");
            vision = await probeVision(baseUrl, apiKey, model.id);
            ctx.ui.notify(`  vision: ${vision.vision ? "yes" : "no"} — ${vision.detail}`, "info");

            // Tag/probe mismatch report (the whole point of probing)
            const taggedReasoning = (model.labels ?? []).some((l) => l.toLowerCase() === "reasoning");
            if (thinking && !thinking.error && taggedReasoning !== thinking.emitsReasoning) {
              ctx.ui.notify(
                `  ⚠ tag mismatch: server labels say reasoning=${taggedReasoning}, probe says ${thinking.emitsReasoning} — trusting the probe.`,
                "warning",
              );
            }
          } else {
            ctx.ui.notify(
              `  skip: keeping catalog capabilities as-is${flags.includes("--no-probe") ? " (--no-probe)" : ""}`,
              "info",
            );
          }

          // Checkpoint-exact sampling metadata from the GGUF file itself
          // (general.sampling.* kvs). Fetched only when the backfill could
          // actually write — target sampling row absent. A catalogued,
          // user-amended model never pays the (slow) HF metadata fetch.
          const targetRow: "thinking" | "nonThinking" | undefined =
            doProbe && thinking && !thinking.error
              ? thinking.emitsReasoning
                ? "thinking"
                : "nonThinking"
              : prevMeta?.probe.thinking !== undefined
                ? prevMeta.probe.thinking
                  ? "thinking"
                  : "nonThinking"
                : undefined;
          let gguf: { sampling?: { temp?: number; top_p?: number; top_k?: number; min_p?: number }; ref?: string } | undefined;
          if (!model.checkpoint) {
            ctx.ui.notify(`  gguf: no checkpoint pointer on this model — skipped`, "info");
          } else if (!ggufBackfillNeeded(true, targetRow, existing as Record<string, unknown> | undefined)) {
            ctx.ui.notify(`  gguf: skipped — sampling row already set (no backfill needed)`, "info");
          } else {
            ctx.ui.notify(`  fetching GGUF metadata from checkpoint (${model.checkpoint})…`, "info");
            const info = await fetchGgufParams(model.checkpoint);
            if (info?.sampling && Object.keys(info.sampling).length > 0) {
              gguf = { sampling: info.sampling, ref: model.checkpoint };
              const s = info.sampling;
              ctx.ui.notify(
                `  gguf: temp=${s.temp ?? "—"} top_p=${s.top_p ?? "—"} top_k=${s.top_k ?? "—"} min_p=${s.min_p ?? "—"}` +
                  (info.architecture ? ` arch=${info.architecture}` : ""),
                "info",
              );
            } else {
              ctx.ui.notify(
                `  gguf: no embedded sampling metadata — sampling rows left unset (server defaults stand)`,
                "info",
              );
            }
          }

          const entry = buildTunedEntry(model, thinking, vision, gguf, existing as Record<string, unknown> | undefined);
          const tier = existing ? "user tier (existing, merged)" : "new user-tier entry";

          // --json: raw entry, no write (escape hatch / scripting)
          if (flags.includes("--json")) {
            ctx.ui.notify(
              `Proposed catalog entry for ${model.id} (provenance in _meta):\n` +
                "```json\n" + JSON.stringify(entry, null, 2) + "\n```",
              "info",
            );
            return;
          }

          // Readable overview (replaces the old raw-JSON dump)
          ctx.ui.notify(
            renderEntryOverview(model.id, entry, {
              tier,
              loaded: model.loaded,
              ctxWindow: model.max_context_window,
              serverTags: model.labels,
            }),
            "info",
          );

          // Fullscreen tune mask: every tunable in one list, ↑↓/tab to move,
          // ←→ to toggle/nudge, enter to edit, s to validate + write.
          let alreadyWritten = false;
          if (!flags.includes("--yes") && ctx.ui.custom) {
            let lastWriteError: string | undefined;
            let outcome: "saved" | "cancelled" = "cancelled";
            await ctx.ui.custom<void>((tui, theme, _kb, done) =>
              createTuneScreen({
                entry,
                meta: {
                  id: model.id,
                  tier,
                  loaded: model.loaded,
                  ctxWindow: model.max_context_window,
                  tags: model.labels,
                  probedAt,
                },
                tui,
                style: tuneThemeStyle(theme),
                matches: matchesKey,
                callbacks: {
                  onCommit: (e) => {
                    // Single sanctioned write path: atomic, never clobbers
                    // a corrupt user file (reported back, screen stays open).
                    const wr = upsertUserParamsEntry(model.id, e as ModelParamsEntry);
                    if (wr === "abort-corrupt") {
                      const msg =
                        `${userParamsPath()} is corrupt and was left untouched.\n` +
                        `Fix or remove the file, then re-run: /lemonade tune ${model.id}`;
                      lastWriteError = msg;
                      return msg;
                    }
                    if (wr === "error") {
                      const msg = `Failed to write ${userParamsPath()}.`;
                      lastWriteError = msg;
                      return msg;
                    }
                    lastWriteError = undefined; // a later save supersedes earlier failures
                    alreadyWritten = true;
                    return "ok";
                  },
                  onClose: (committed) => {
                    outcome = committed && !lastWriteError ? "saved" : "cancelled";
                    done(undefined);
                  },
                },
              }),
            );
            if (outcome === "saved") {
              // falls through to the re-sync below (entry already written)
            } else if (lastWriteError) {
              ctx.ui.notify(lastWriteError, "error");
              return;
            } else {
              ctx.ui.notify("Tune cancelled — nothing written.", "info");
              return;
            }
          } else if (flags.includes("--yes")) {
            ctx.ui.notify(`Writing entry for ${model.id} (--yes — editor skipped).`, "info");
          }

          if (alreadyWritten) {
            // Written by the mask — skip the shared write path below.
          } else {
            // Single sanctioned write path: atomic (tmp+rename), and a corrupt
            // user file is NEVER clobbered — the write is aborted with a warning.
            const writeResult = upsertUserParamsEntry(model.id, entry as ModelParamsEntry);
            if (writeResult === "abort-corrupt") {
              ctx.ui.notify(
                `NOT WRITTEN — ${userParamsPath()} is corrupt and was left untouched.\n` +
                  `Fix or remove the file, then re-run: /lemonade tune ${model.id}\n` +
                  "(re-running re-probes and re-offers the entry; nothing is lost)",
                "error",
              );
              return;
            }
            if (writeResult === "error") {
              ctx.ui.notify(`Failed to write ${userParamsPath()}.`, "error");
              return;
            }
          }

          // Re-sync so the new capabilities take effect without a restart.
          await registerLemonadeProvider(pi, payload, oauthBlock);
          syncModelStore(payload.baseUrl, payload.apiKey);
          ctx.ui.notify(
            `✓ ${model.id} configured. Provider re-registered — capabilities active now.\n` +
              `(Sampling applies per-request; capabilities/maxTokens apply on this re-sync.)`,
            "info",
          );
          return;
        }

        default:
          ctx.ui.notify(`Unknown command: /lemonade ${cmd}\nType /lemonade help`, "warning");
      }
    },
  });
}

// ─── Model operation helper ─────────────────────────────────────────────────

async function postModelOp(
  ctx: PiCommandContext,
  url: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  label: string,
) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await r.json().catch(() => ({}) as Record<string, unknown>);
    if (!r.ok) {
      const msg =
        (data as { error?: { message?: string } | string })?.error &&
        typeof (data as { error?: { message?: string } }).error === "object"
          ? (data as { error: { message?: string } }).error.message
          : ((data as { error?: string }).error ?? r.statusText);
      ctx.ui.notify(`${label} failed: ${msg}`, "error");
      return;
    }
    const successMsg =
      (data as { message?: string }).message ??
      `${label} succeeded${(data as { model_name?: string }).model_name ? `: ${(data as { model_name?: string }).model_name}` : ""}`;
    ctx.ui.notify(successMsg, "info");
  } catch (e) {
    ctx.ui.notify(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}
