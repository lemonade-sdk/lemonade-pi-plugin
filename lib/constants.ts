/**
 * @lemonade/lemonade-provider
 *
 * Constants used throughout the extension.
 */

export const PROVIDER_ID = "lemonade";
export const PROVIDER_LABEL = "Lemonade";
export const BEACON_PORT = 13305;

// Lemonade's default HTTP port is 13305 (same port as the UDP beacon, but TCP).
// Listed first so the local-fallback scan finds it immediately. Other ports
// covered for users running a custom --port.
export const HTTP_FALLBACK_PORTS = [13305, 8000, 1234, 9000, 8080];
export const DEFAULT_HTTP_URL = "http://localhost:13305";
export const CREDS_TTL_MS = 24 * 60 * 60 * 1000;
