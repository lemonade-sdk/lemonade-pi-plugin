/**
 * @lemonade/lemonade-provider
 *
 * UDP beacon discovery and HTTP fallback port scanning.
 */

import dgram from "node:dgram";
import type { BeaconResult, LemonadeHealth } from "./types.js";
import { BEACON_PORT, HTTP_FALLBACK_PORTS } from "./constants.js";
import { buildBaseUrl } from "./url-helpers.js";

// ─── UDP beacon discovery ───────────────────────────────────────────────────

/**
 * Listen on UDP 13305 for Lemonade beacons.
 * Lemonade broadcasts {"service":"lemonade","hostname":"...","url":"http://.../api/v1/"}
 * roughly every second to loopback and every RFC1918 broadcast address.
 *
 * localOnly=true accepts only loopback senders (matches the lemonade CLI's
 * discover_local_server_port). false accepts any sender, for LAN-wide scans.
 */
export function discoverViaBeacon(timeoutMs: number, localOnly: boolean): Promise<BeaconResult[]> {
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

export async function discoverViaHttp(): Promise<BeaconResult[]> {
  const checks = await Promise.all(
    HTTP_FALLBACK_PORTS.map(async (port) => {
      const baseUrl = `http://localhost:${port}`;
      const health = await checkHealth(baseUrl);
      return health ? { hostname: `localhost:${port}`, baseUrl } : null;
    }),
  );
  return checks.filter((r): r is BeaconResult => r !== null);
}

export async function discoverServers(timeoutMs = 2500): Promise<BeaconResult[]> {
  const beacons = await discoverViaBeacon(timeoutMs, /*localOnly=*/ false);
  if (beacons.length > 0) return beacons;
  return await discoverViaHttp();
}

// ─── HTTP health check (local helper for discovery) ─────────────────────────

async function checkHealth(baseUrl: string): Promise<unknown> {
  try {
    const res = await fetch(`${baseUrl}/api/v1/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
