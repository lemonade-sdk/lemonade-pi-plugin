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
import { registerLemonadeProvider } from "./provider.js";
import { discoverViaBeacon, discoverViaHttp } from "./discovery.js";
import { fmtHealth } from "./health.js";

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
            "  discover           — UDP beacon + HTTP port scan",
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
          ctx.ui.notify(`Re-synced: ${count} models registered.`, "info");
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
