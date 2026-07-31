/**
 * @lemonade/lemonade-provider
 *
 * URL building and authorization header helpers.
 */

export function buildBaseUrl(raw: string): string {
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

export function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (apiKey) h["Authorization"] = `Bearer ${apiKey}`;
  return h;
}
