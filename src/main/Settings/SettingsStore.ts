// Reads and writes userData/settings.json. API keys are encrypted with
// Electron's safeStorage (OS keychain) when available; on platforms where
// it's not (rare — typically a Linux host without libsecret) we fall back
// to writing the key in plain text and log a warning.
//
// safeStorage is only usable after app.whenReady(), so callers must construct
// this store after that point. The Window constructor satisfies that.

import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  API_KEY_PROVIDERS,
  DEFAULT_AGENT_PREFERENCES,
  SETTINGS_FILENAME,
  SETTINGS_VERSION,
  type AgentPreferences,
  type ApiKeyProvider,
  type ApiKeyStatus,
  type PersistedSettings,
  type StoredApiKey,
  type StoredModelSelection,
} from "./SettingsTypes";

const EMPTY_SETTINGS: PersistedSettings = {
  version: SETTINGS_VERSION,
  apiKeys: {},
  lastModel: null,
  agentPreferences: DEFAULT_AGENT_PREFERENCES,
};

export class SettingsStore {
  private readonly filePath: string;
  private data: PersistedSettings = EMPTY_SETTINGS;
  private encryptionAvailable: boolean;

  constructor() {
    const userData = app.getPath("userData");
    // Boot-time prep: userData always exists in practice, but mkdirSync is
    // idempotent and runs once during app.whenReady. Writes go async below.
    mkdirSync(userData, { recursive: true });
    this.filePath = join(userData, SETTINGS_FILENAME);
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (!this.encryptionAvailable) {
      console.warn(
        "[SettingsStore] safeStorage encryption unavailable on this platform; API keys will be stored in plaintext.",
      );
    }
    this.loadFromDiskSync();
  }

  // ---- API keys ----

  getApiKey(provider: ApiKeyProvider): string | null {
    const stored = this.data.apiKeys[provider];
    if (!stored) return null;
    return this.decrypt(stored);
  }

  async setApiKey(provider: ApiKeyProvider, key: string): Promise<void> {
    const trimmed = key.trim();
    if (!trimmed) {
      await this.clearApiKey(provider);
      return;
    }
    const stored = this.encrypt(trimmed);
    this.data = {
      ...this.data,
      apiKeys: { ...this.data.apiKeys, [provider]: stored },
    };
    await this.saveToDisk();
  }

  async clearApiKey(provider: ApiKeyProvider): Promise<void> {
    if (!this.data.apiKeys[provider]) return;
    const nextKeys = { ...this.data.apiKeys };
    delete nextKeys[provider];
    this.data = { ...this.data, apiKeys: nextKeys };
    await this.saveToDisk();
  }

  getApiKeyStatuses(envFallback: Record<ApiKeyProvider, string | undefined>):
    ReadonlyArray<ApiKeyStatus> {
    return API_KEY_PROVIDERS.map((provider) => {
      const stored = this.data.apiKeys[provider];
      if (stored) {
        const key = this.decrypt(stored);
        return {
          provider,
          configured: !!key,
          source: "ui" as const,
          preview: previewKey(key),
          updatedAt: stored.updatedAt,
        };
      }
      const envKey = envFallback[provider];
      if (envKey) {
        return {
          provider,
          configured: true,
          source: "env" as const,
          preview: previewKey(envKey),
          updatedAt: null,
        };
      }
      return {
        provider,
        configured: false,
        source: "none" as const,
        preview: null,
        updatedAt: null,
      };
    });
  }

  // ---- Last-used model ----

  getLastModel(): StoredModelSelection | null {
    return this.data.lastModel;
  }

  async setLastModel(selection: StoredModelSelection): Promise<void> {
    this.data = { ...this.data, lastModel: selection };
    await this.saveToDisk();
  }

  // ---- Agent preferences ----

  getAgentPreferences(): AgentPreferences {
    return { ...DEFAULT_AGENT_PREFERENCES, ...(this.data.agentPreferences ?? {}) };
  }

  async setAgentPreferences(
    prefs: Partial<AgentPreferences>,
  ): Promise<AgentPreferences> {
    const next: AgentPreferences = { ...this.getAgentPreferences(), ...prefs };
    this.data = { ...this.data, agentPreferences: next };
    await this.saveToDisk();
    return next;
  }

  // ---- internals ----

  // Sync read is intentional — runs once during app.whenReady on a small JSON
  // file. Writes use fs/promises so the hot path doesn't block the main thread.
  private loadFromDiskSync(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.data = EMPTY_SETTINGS;
        return;
      }
      const raw = readFileSync(this.filePath, "utf8");
      if (!raw.trim()) {
        this.data = EMPTY_SETTINGS;
        return;
      }
      const parsed = JSON.parse(raw) as PersistedSettings;
      this.data = this.migrate(parsed);
    } catch (error) {
      console.error("[SettingsStore] Failed to read settings file:", error);
      this.data = EMPTY_SETTINGS;
    }
  }

  private migrate(input: PersistedSettings): PersistedSettings {
    return {
      version: SETTINGS_VERSION,
      apiKeys: input.apiKeys ?? {},
      lastModel: input.lastModel ?? null,
      agentPreferences: { ...DEFAULT_AGENT_PREFERENCES, ...(input.agentPreferences ?? {}) },
    };
  }

  private async saveToDisk(): Promise<void> {
    try {
      const serialised = JSON.stringify(this.data, null, 2);
      await writeFile(this.filePath, serialised, "utf8");
    } catch (error) {
      console.error("[SettingsStore] Failed to write settings file:", error);
    }
  }

  private encrypt(plaintext: string): StoredApiKey {
    if (this.encryptionAvailable) {
      try {
        const cipher = safeStorage.encryptString(plaintext);
        return {
          value: cipher.toString("base64"),
          encrypted: true,
          updatedAt: Date.now(),
        };
      } catch (error) {
        console.error(
          "[SettingsStore] safeStorage.encryptString failed; storing plaintext:",
          error,
        );
      }
    }
    return {
      value: plaintext,
      encrypted: false,
      updatedAt: Date.now(),
    };
  }

  private decrypt(stored: StoredApiKey): string | null {
    if (!stored.encrypted) return stored.value || null;
    if (!this.encryptionAvailable) {
      console.error(
        "[SettingsStore] Stored value is encrypted but safeStorage is unavailable on this platform — cannot decrypt.",
      );
      return null;
    }
    try {
      const buffer = Buffer.from(stored.value, "base64");
      return safeStorage.decryptString(buffer);
    } catch (error) {
      console.error("[SettingsStore] safeStorage.decryptString failed:", error);
      return null;
    }
  }
}

function previewKey(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
