/**
 * @lemonade/lemonade-provider
 *
 * Generic outgoing-payload capture — ALL providers/models, not Qwen-only.
 *
 * Opt-in via LEMONADE_PAYLOAD_DEBUG=1 (set it in your shell env or the
 * devstack .env, where LPB_PAYLOAD_DEBUG is bridged to this name).
 * The plugin's before_provider_request handler appends one JSON line per
 * provider request to /tmp/pi-payload-capture.jsonl: the payload as the
 * handler LEAVES it (tuned view for catalogued models, raw view for
 * everything else) plus ctx metadata.
 *
 * Best-effort: never throws, never breaks a request.
 */

import * as fs from "node:fs";

export const PAYLOAD_DEBUG_PATH = "/tmp/pi-payload-capture.jsonl";

/**
 * Append one JSON line describing `payload` (as the plugin leaves it) to
 * the capture file. `meta` carries ctx values that may not be in the
 * payload itself (model id, thinking level).
 */
export function writePayloadDebugLog(
  payload: Record<string, unknown>,
  meta: { model?: string; thinkingLevel?: string } = {},
): void {
  try {
    const summary: Record<string, unknown> = {
      ts: new Date().toISOString(),
      source: "lemonade-pi-plugin",
      model: meta.model ?? payload.model ?? null,
      thinkingLevel: meta.thinkingLevel ?? null,
      chat_template_kwargs: payload.chat_template_kwargs ?? null,
      thinking_budget_tokens: payload.thinking_budget_tokens ?? null,
      reasoning_budget_tokens: payload.reasoning_budget_tokens ?? null,
      reasoning_effort: payload.reasoning_effort ?? null,
      enable_thinking: payload.enable_thinking ?? null,
      max_tokens: payload.max_tokens ?? payload.max_completion_tokens ?? null,
      temperature: payload.temperature ?? null,
      top_p: payload.top_p ?? null,
      top_k: payload.top_k ?? null,
      min_p: payload.min_p ?? null,
      presence_penalty: payload.presence_penalty ?? null,
      repetition_penalty: payload.repetition_penalty ?? null,
      topKeys: Object.keys(payload).sort(),
    };
    fs.mkdirSync("/tmp", { recursive: true });
    fs.appendFileSync(PAYLOAD_DEBUG_PATH, JSON.stringify(summary) + "\n");
  } catch {
    // debugging must never break a request
  }
}
