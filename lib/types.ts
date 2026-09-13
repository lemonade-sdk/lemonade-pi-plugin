/**
 * @lemonade/lemonade-provider
 *
 * Type definitions shared across the extension.
 * Pi resolves the real types at runtime via jiti; declaring local interfaces
 * keeps this file type-checkable without the peerDependency installed.
 */

// ─── Pi interfaces ──────────────────────────────────────────────────────────

import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface ExtensionAPI {
  registerProvider(id: string, config: Record<string, unknown>): void;
  unregisterProvider(id: string): void;
  registerCommand(
    name: string,
    options: {
      description?: string;
      /** Optional argument auto-completion (pi TUI); prefix is the raw args text. */
      getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
      handler: (args: string, ctx: PiCommandContext) => Promise<void>;
    },
  ): void;
  /**
   * Register an extension event handler. Used for `before_provider_request`:
   * the handler receives `(event, ctx)` and its RETURN VALUE replaces the
   * outgoing wire payload (return undefined to pass it through untouched).
   */
  on(
    event: "before_provider_request",
    handler: (
      event: { type: "before_provider_request"; payload?: Record<string, unknown> },
      ctx: { thinkingLevel?: string; model?: { id?: string } },
    ) => Record<string, unknown> | undefined,
  ): void;
}

export interface PiCommandContext {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    input?(prompt: string, placeholder?: string): Promise<string>;
    select?<T>(prompt: string, options: T[]): Promise<T>;
    /**
     * pi's custom-UI host (docs/tui.md): open a fullscreen component and
     * await its result. Structurally typed — the component object is the
     * standard { render, handleInput, invalidate } triple.
     */
    custom?<T>(
      factory: (
        tui: { requestRender(): void },
        theme: { fg?: (color: string, text: string) => string },
        keybindings: unknown,
        done: (value: T) => void,
      ) => { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void },
    ): Promise<T>;
  };
  signal?: AbortSignal;
}

// ─── Lemonade server types ──────────────────────────────────────────────────

export interface BackendModel {
  type: string;
  model_name: string;
  checkpoint: string;
  loaded: boolean;
  status: string;
  backend_alive: boolean;
  backend_health: string;
  backend_url: string;
  device: string;
  pid: number;
  max_context_window: number;
  pinned: boolean;
  recipe: string;
  recipe_options: {
    ctx_size: number;
    llamacpp_args: string;
    pinned: boolean;
    [k: string]: unknown;
  };
  watchdog_reset: boolean;
  last_use: number;
}

export interface LemonadeHealth {
  status: string;
  version: string;
  model_loaded: string | null;
  all_models_loaded: BackendModel[];
  websocket_port: number;
  max_models: Record<string, number>;
  pinned_models: Record<string, number>;
  telemetry: { enabled: boolean };
}

export interface LemonadeModelInfo {
  id: string;
  name?: string;
  category?: string;
  backend?: string;
  recipe?: string;
  loaded?: boolean;
  size?: number;
  max_context_window?: number;
  recipe_options?: {
    ctx_size?: number;
    llamacpp_args?: string;
    pinned?: boolean;
    [k: string]: unknown;
  };
  backend_url?: string;
  config?: Record<string, unknown>;
  labels?: string[];
  /**
   * Checkpoint pointer in Lemonade's `"<hf-repo>:<file>"` shape (e.g.
   * `unsloth/Qwen3.8-27B-GGUF:Qwen3.8-27B-UD-Q4_K_XL.gguf`). Used by
   * `/lemonade tune` to fetch the checkpoint's embedded GGUF sampling
   * metadata.
   */
  checkpoint?: string;
}

// ─── OAuth types ────────────────────────────────────────────────────────────

export interface OAuthCredentials {
  refresh: string;
  access: string;
  expires: number;
}

export interface OAuthLoginCallbacks {
  onAuth(params: { url: string }): void;
  onDeviceCode(params: { userCode: string; verificationUri: string }): void;
  onPrompt(params: { message: string }): Promise<string>;
}

export interface CredsPayload {
  baseUrl: string;
  apiKey: string;
  serverName: string;
}

// ─── Discovery types ────────────────────────────────────────────────────────

export interface BeaconResult {
  hostname: string;
  baseUrl: string;
}
