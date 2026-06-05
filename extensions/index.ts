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

import dgram from "node:dgram";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// Pi's ExtensionAPI shape — only the surface we actually use. Pi resolves the
// real type at runtime via jiti; declaring a local interface keeps this file
// type-checkable without the peerDependency installed in the extension dir.
interface ExtensionAPI {
  registerProvider(id: string, config: Record<string, unknown>): void;
  unregisterProvider(id: string): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;
}

interface PiCommandContext {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    input?(prompt: string, placeholder?: string): Promise<string>;
    select?<T>(prompt: string, options: T[]): Promise<T>;
  };
  signal?: AbortSignal;
}

const PROVIDER_ID = "lemonade";
const PROVIDER_LABEL = "Lemonade";
const BEACON_PORT = 13305;
// Lemonade's default HTTP port is 13305 (same port as the UDP beacon, but TCP).
// Listed first so the local-fallback scan finds it immediately. Other ports
// covered for users running a custom --port.
const HTTP_FALLBACK_PORTS = [13305, 8000, 1234, 9000, 8080];
const DEFAULT_HTTP_URL = "http://localhost:13305";
const CREDS_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Types ──────────────────────────────────────────────────────────────────

interface LemonadeHealth {
  status: string;
  version: string;
  model_loaded: string | null;
  all_models_loaded?: string[] | null;
  websocket_port?: number;
}

interface LemonadeModelInfo {
  id: string;
  name?: string;
  category?: string;
  backend?: string;
  recipe?: string;
  loaded?: boolean;
  size?: number;
  config?: Record<string, unknown>;
}

interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void;
  onDeviceCode(params: { userCode: string; verificationUri: string }): void;
  onPrompt(params: { message: string }): Promise<string>;
}

interface CredsPayload {
  baseUrl: string;
  apiKey: string;
  serverName: string;
}

interface BeaconResult {
  hostname: string;
  baseUrl: string;
}

// ─── Credential encoding ────────────────────────────────────────────────────

function encodeCreds(payload: CredsPayload): OAuthCredentials {
  return {
    refresh: JSON.stringify(payload),
    access: payload.apiKey,
    expires: Date.now() + CREDS_TTL_MS,
  };
}

function decodeCreds(creds: OAuthCredentials): CredsPayload {
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

// ─── URL helpers ────────────────────────────────────────────────────────────

function buildBaseUrl(raw: string): string {
  let url = (raw ?? "").trim();
  if (!url) return "";
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) {
    url = `http://${url}`;
  }
  // Strip any path the user (or the beacon) appended. Order matters — strip
  // the most specific prefix first.
  //   http://host:port/api/v1/  → http://host:port
  //   http://host:port/api/v0   → http://host:port
  //   http://host:port/v1       → http://host:port (user pasted from OpenAI URL)
  //   http://host:port/api      → http://host:port
  for (const re of [/\/api\/v\d+\/?$/i, /\/v\d+\/?$/i, /\/api\/?$/i]) {
    url = url.replace(re, "");
  }
  return url.replace(/\/+$/, "");
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}

// ─── UDP beacon discovery ───────────────────────────────────────────────────

/**
 * Listen on UDP 13305 for Lemonade beacons.
 * Lemonade broadcasts {"service":"lemonade","hostname":"...","url":"http://.../api/v1/"}
 * roughly every second to loopback and every RFC1918 broadcast address.
 *
 * localOnly=true accepts only loopback senders (matches the lemonade CLI's
 * discover_local_server_port). false accepts any sender, for LAN-wide scans.
 */
function discoverViaBeacon(timeoutMs: number, localOnly: boolean): Promise<BeaconResult[]> {
  return new Promise((resolve) => {
    const found = new Map<string, BeaconResult>();
    let sock: ReturnType<typeof dgram.createSocket> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (sock) {
        try {
          sock.close();
        } catch {
          // ignore
        }
        sock = null;
      }
      resolve(Array.from(found.values()));
    };

    try {
      // reuseAddr → SO_REUSEADDR; reusePort → SO_REUSEPORT (Node 18+).
      // Both are required on macOS to co-bind with another listener (tray,
      // `lemonade scan`). The peer must also set them, so this only works
      // once the lemonade tray is patched to set SO_REUSEPORT before bind.
      sock = dgram.createSocket({
        type: "udp4",
        reuseAddr: true,
        reusePort: true,
      } as Parameters<typeof dgram.createSocket>[0]);
      sock.on("error", finish);
      sock.on("message", (msg: Buffer, rinfo: { address: string }) => {
        if (localOnly && rinfo.address !== "127.0.0.1") return;
        try {
          const beacon = JSON.parse(msg.toString());
          if (beacon?.service !== "lemonade") return;
          const url = String(beacon.url ?? "");
          const hostname = String(beacon.hostname ?? "unknown");
          if (!url) return;
          const baseUrl = buildBaseUrl(url);
          if (baseUrl && !found.has(baseUrl)) {
            found.set(baseUrl, { hostname, baseUrl });
          }
        } catch {
          // not JSON / not ours
        }
      });
      sock.bind(BEACON_PORT);
    } catch {
      finish();
      return;
    }

    timer = setTimeout(finish, timeoutMs);
  });
}

async function discoverViaHttp(): Promise<BeaconResult[]> {
  const checks = await Promise.all(
    HTTP_FALLBACK_PORTS.map(async (port) => {
      const baseUrl = `http://localhost:${port}`;
      const health = await checkHealth(baseUrl);
      return health ? { hostname: `localhost:${port}`, baseUrl } : null;
    }),
  );
  return checks.filter((r): r is BeaconResult => r !== null);
}

async function discoverServers(timeoutMs = 2500): Promise<BeaconResult[]> {
  const beacons = await discoverViaBeacon(timeoutMs, /*localOnly=*/ false);
  if (beacons.length > 0) return beacons;
  return await discoverViaHttp();
}

// ─── HTTP calls ─────────────────────────────────────────────────────────────

async function checkHealth(baseUrl: string, apiKey?: string): Promise<LemonadeHealth | null> {
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

async function fetchModels(baseUrl: string, apiKey?: string): Promise<LemonadeModelInfo[]> {
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

// ─── Provider model mapping ─────────────────────────────────────────────────

function isReasoningModel(recipe: string | undefined): boolean {
  if (!recipe) return false;
  const r = recipe.toLowerCase();
  return ["qwq", "deepseek-r1", "r1", "o1", "o3", "think"].some((t) => r.includes(t));
}

function mapToProviderModel(m: LemonadeModelInfo) {
  const input: ("text" | "image")[] = ["text"];
  if (m.category === "image" || (m.backend ?? "").toLowerCase().includes("sd")) {
    input.push("image");
  }
  const cfg = m.config ?? {};
  const contextWindow =
    (cfg["context_window"] as number) ?? (cfg["context_len"] as number) ?? 256000;
  const maxTokens =
    (cfg["max_new_tokens"] as number) ?? (cfg["max_tokens"] as number) ?? 8192;
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: isReasoningModel(m.recipe),
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}

// ─── Provider (re-)registration ─────────────────────────────────────────────

async function registerLemonadeProvider(
  pi: ExtensionAPI,
  payload: CredsPayload | null,
  oauthBlock: unknown,
): Promise<number> {
  const baseUrl = payload?.baseUrl ?? "";
  let providerModels: ReturnType<typeof mapToProviderModel>[] = [];
  if (baseUrl) {
    const raw = await fetchModels(baseUrl, payload?.apiKey);
    providerModels = raw.map(mapToProviderModel);
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

// ─── OAuth login flow (runs when user picks "Lemonade" in /login) ───────────

async function oauthLogin(
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

  const payload: CredsPayload = {
    baseUrl,
    apiKey,
    serverName: `${serverName} v${health.version}`,
  };
  await registerLemonadeProvider(pi, payload, oauthBlock);

  return encodeCreds(payload);
}

// ─── /lemonade admin command ────────────────────────────────────────────────

function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Best-effort: read Pi's persisted OAuth credentials so the admin command
 * works without making a network call to the OAuth flow. The on-disk format
 * is undocumented; we try a couple of reasonable shapes.
 */
async function readStoredPayload(): Promise<CredsPayload | null> {
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

function registerAdminCommand(pi: ExtensionAPI, oauthBlock: unknown) {
  pi.registerCommand("lemonade", {
    description: "Lemonade server administration (status, models, load/pull/delete)",
    handler: async (args: string, ctx: { ui: { notify(msg: string, level?: string): void } }) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] ?? "").toLowerCase();
      const rest = parts.slice(1);

      if (cmd === "" || cmd === "help") {
        ctx.ui.notify(
          "/lemonade <command>\n" +
            "  status             — server health\n" +
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
            if (m.recipe) {
              out += `      recipe: ${m.recipe}, backend: ${m.backend ?? "—"}\n`;
            }
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

async function postModelOp(
  ctx: { ui: { notify(msg: string, level?: string): void } },
  url: string,
  apiKey: string | undefined,
  body: Record<string, unknown>,
  label: string,
) {
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: authHeaders(apiKey),
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

// ─── Extension factory ──────────────────────────────────────────────────────

export default async function lemonadeProvider(pi: ExtensionAPI) {
  const oauthBlock = {
    name: PROVIDER_LABEL,
    login: (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> =>
      oauthLogin(pi, callbacks, oauthBlock),
    refreshToken: async (creds: OAuthCredentials): Promise<OAuthCredentials> => {
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
    getApiKey: (creds: OAuthCredentials): string => {
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
