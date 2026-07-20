/**
 * @lemonade/lemonade-provider
 *
 * Type definitions shared across the extension.
 * Pi resolves the real types at runtime via jiti; declaring local interfaces
 * keeps this file type-checkable without the peerDependency installed.
 */

// ─── Pi interfaces ──────────────────────────────────────────────────────────

export interface ExtensionAPI {
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

export interface PiCommandContext {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    input?(prompt: string, placeholder?: string): Promise<string>;
    select?<T>(prompt: string, options: T[]): Promise<T>;
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
