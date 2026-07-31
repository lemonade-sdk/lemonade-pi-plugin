/**
 * @lemonade/lemonade-provider
 *
 * Formats LemonadeHealth into a rich multi-line display with backend details,
 * recipe options, and model limits.
 */

import type { LemonadeHealth, BackendModel } from "./types.js";

export function fmtHealth(h: LemonadeHealth): string {
  const l: string[] = [];

  l.push("");
  l.push(`🍋 Lemonade v${h.version} — Health Status`);
  l.push("━".repeat(40));
  l.push(`Status:          ${h.status}`);
  l.push(`WebSocket port:  ${h.websocket_port}`);
  l.push(`Loaded model:    ${h.model_loaded ?? "(none)"}`);
  l.push(`Telemetry:       ${h.telemetry?.enabled ? "enabled" : "disabled"}`);

  l.push("");
  l.push("📊 Max Models");
  l.push("─".repeat(20));
  const mx = h.max_models;
  l.push(`  LLM:           ${mx.llm ?? "?"}`);
  l.push(`  Embedding:     ${mx.embedding ?? "?"}`);
  l.push(`  Image:         ${mx.image ?? "?"}`);
  l.push(`  Reranking:     ${mx.reranking ?? "?"}`);
  l.push(`  Transcription: ${mx.transcription ?? "?"}`);
  l.push(`  TTS:           ${mx.tts ?? "?"}`);

  const pn = h.pinned_models;
  const tp = Object.values(pn).reduce((s, v) => s + (v as number), 0);
  if (tp > 0) {
    l.push("");
    l.push("📌 Pinned Models");
    l.push("─".repeat(20));
    for (const [k, v] of Object.entries(pn)) {
      if ((v as number) > 0) l.push(`  ${k}: ${(v as number)}`);
    }
  }

  if (h.all_models_loaded.length === 0) {
    l.push("");
    l.push("🔧 No models loaded");
    return l.join("\n");
  }

  for (const bm of h.all_models_loaded) {
    l.push("");
    l.push(`🔧 Model: ${bm.model_name}`);
    l.push("─".repeat(45));
    l.push(`  Checkpoint:         ${bm.checkpoint}`);
    l.push(`  Status:             ${bm.status}`);
    l.push(`  Type:               ${bm.type}`);
    l.push(`  Device:             ${bm.device}`);
    l.push(`  PID:                ${bm.pid}`);
    l.push(`  Loaded:             ${bm.loaded ? "✓" : "✗"}`);
    l.push(`  Pinned:             ${bm.pinned ? "✓" : "✗"}`);
    l.push(`  Max Context Window: ${bm.max_context_window.toLocaleString()} tokens`);
    l.push(`  Backend alive:      ${bm.backend_alive ? "✓" : "✗"}`);
    l.push(`  Backend health:     ${bm.backend_health}`);
    l.push(`  Backend URL:        ${bm.backend_url}`);
    l.push(`  Watchdog reset:     ${bm.watchdog_reset ? "✓" : "✗"}`);
    l.push(`  Recipe:             ${bm.recipe}`);

    if (bm.recipe_options) {
      l.push("");
      l.push("  ⚙️ Recipe Options");
      l.push("  " + "─".repeat(40));
      l.push(`    ${"ctx_size".padEnd(20)} ${bm.recipe_options.ctx_size.toLocaleString()} tokens`);
      l.push(`    ${"pinned".padEnd(20)} ${bm.recipe_options.pinned ? "✓" : "✗"}`);
      if (bm.recipe_options.llamacpp_args) {
        const args = splitArgs(bm.recipe_options.llamacpp_args);
        const kv: Record<string, string> = {};
        for (let i = 0; i < args.length; i++) {
          if (args[i].startsWith("--")) {
            const key = args[i].slice(2);
            const val = (i + 1 < args.length && !args[i + 1].startsWith("--"))
              ? args[i + 1] : "true";
            kv[key] = val;
            i++;
          }
        }
        for (const [k, v] of Object.entries(kv)) {
          const display = v.replace(/^'|'$/g, "").replace(/^"|"$/g, "");
          l.push(`    ${k.padEnd(20)} ${display}`);
        }
      }
      const handled = new Set(["ctx_size", "pinned", "llamacpp_args"]);
      for (const [k, v] of Object.entries(bm.recipe_options)) {
        if (handled.has(k)) continue;
        l.push(`    ${k.padEnd(20)} ${String(v)}`);
      }
    }
  }

  return l.join("\n");
}

function splitArgs(raw: string): string[] {
  const r: string[] = [];
  let cur = "", inQ = false, qc = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (!inQ && (ch === '"' || ch === "'")) { inQ = true; qc = ch; }
    else if (inQ && ch === qc) { inQ = false; }
    else if (!inQ && ch === " ") { if (cur) r.push(cur); cur = ""; }
    else { cur += ch; }
  }
  if (cur) r.push(cur);
  return r;
}
