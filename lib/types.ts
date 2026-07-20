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

export interface LemonadeHealth {
  status: string;
  version: string;
  model_loaded: string | null;
  all_models_loaded?: string[] | null;
  websocket_port?: number;
}

export interface LemonadeModelInfo {
  id: string;
  name?: string;
  category?: string;
  backend?: string;
  recipe?: string;
  loaded?: boolean;
  size?: number;
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
