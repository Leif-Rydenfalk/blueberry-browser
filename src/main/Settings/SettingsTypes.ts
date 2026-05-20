// Persistent application settings stored at userData/settings.json.
//
// Today the surface is small: per-provider API keys (encrypted via Electron
// safeStorage when available, plaintext fallback otherwise), the
// last-selected model, and agent behaviour preferences.
// Bumping `SETTINGS_VERSION` triggers a migration in SettingsStore.loadFromDisk().

export const SETTINGS_VERSION = 2;
export const SETTINGS_FILENAME = "settings.json";

export type ApiKeyProvider = "openai" | "anthropic" | "google";

export const API_KEY_PROVIDERS: ReadonlyArray<ApiKeyProvider> = [
  "openai",
  "anthropic",
  "google",
];

export interface StoredApiKey {
  // Either the base64-encoded safeStorage ciphertext, or the raw key when
  // encryption isn't available on this platform.
  readonly value: string;
  readonly encrypted: boolean;
  readonly updatedAt: number;
}

export interface StoredModelSelection {
  readonly provider: ApiKeyProvider;
  readonly model: string;
}

export interface AgentPreferences {
  readonly alwaysAllowScripts: boolean;
}

export const DEFAULT_AGENT_PREFERENCES: AgentPreferences = {
  alwaysAllowScripts: false,
};

export interface PersistedSettings {
  readonly version: number;
  readonly apiKeys: Partial<Record<ApiKeyProvider, StoredApiKey>>;
  readonly lastModel: StoredModelSelection | null;
  readonly agentPreferences?: AgentPreferences;
}

export const SETTINGS_CHANNELS = {
  GET_API_KEY_STATUS: "settings:get-api-key-status",
  SET_API_KEY: "settings:set-api-key",
  CLEAR_API_KEY: "settings:clear-api-key",
  TEST_API_KEY: "settings:test-api-key",
  GET_AGENT_PREFERENCES: "settings:get-agent-preferences",
  SET_AGENT_PREFERENCES: "settings:set-agent-preferences",
} as const;

export interface ApiKeyStatus {
  readonly provider: ApiKeyProvider;
  readonly configured: boolean;
  readonly source: "ui" | "env" | "none";
  readonly preview: string | null;
  readonly updatedAt: number | null;
}

export interface ApiKeyTestResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly modelCount?: number;
}
