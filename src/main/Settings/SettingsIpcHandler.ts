// Glue layer between the sidebar UI and SettingsStore.
//
// The UI lets users paste a key per provider, test it against the provider's
// model-list endpoint, and clear it. After every mutation we re-initialize
// the LLMClient so the new key takes effect immediately without a restart.

import type { LLMClient } from "../LLMClient";
import type { SettingsStore } from "./SettingsStore";
import {
  API_KEY_PROVIDERS,
  type AgentPreferences,
  type ApiKeyProvider,
  type ApiKeyStatus,
  type ApiKeyTestResult,
} from "./SettingsTypes";

const ANTHROPIC_VERSION = "2023-06-01";

export class SettingsIpcHandler {
  constructor(
    private readonly store: SettingsStore,
    private readonly llmClient: LLMClient,
  ) {}

  getApiKeyStatuses(): ReadonlyArray<ApiKeyStatus> {
    return this.store.getApiKeyStatuses(envFallback());
  }

  async setApiKey(
    provider: ApiKeyProvider,
    key: string,
  ): Promise<ReadonlyArray<ApiKeyStatus>> {
    if (!isValidProvider(provider)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    this.store.setApiKey(provider, key);
    await this.llmClient.refreshFromSettings();
    return this.getApiKeyStatuses();
  }

  async clearApiKey(
    provider: ApiKeyProvider,
  ): Promise<ReadonlyArray<ApiKeyStatus>> {
    if (!isValidProvider(provider)) {
      throw new Error(`Unknown provider: ${provider}`);
    }
    this.store.clearApiKey(provider);
    await this.llmClient.refreshFromSettings();
    return this.getApiKeyStatuses();
  }

  getAgentPreferences(): AgentPreferences {
    return this.store.getAgentPreferences();
  }

  setAgentPreferences(prefs: Partial<AgentPreferences>): AgentPreferences {
    return this.store.setAgentPreferences(prefs);
  }

  // Hits the provider's models endpoint with the supplied key (without
  // persisting it). Used by the UI's "Test" button so users can verify before
  // saving. Returns ok + the number of models discovered.
  async testApiKey(
    provider: ApiKeyProvider,
    key: string,
  ): Promise<ApiKeyTestResult> {
    if (!isValidProvider(provider)) {
      return { ok: false, error: `Unknown provider: ${provider}` };
    }
    const trimmed = key.trim();
    if (!trimmed) return { ok: false, error: "API key is empty" };

    try {
      const count = await fetchModelCount(provider, trimmed);
      if (count == null) {
        return { ok: false, error: "Provider returned no models" };
      }
      return { ok: true, modelCount: count };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
}

function isValidProvider(value: string): value is ApiKeyProvider {
  return (API_KEY_PROVIDERS as ReadonlyArray<string>).includes(value);
}

function envFallback(): Record<ApiKeyProvider, string | undefined> {
  return {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google:
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      process.env.GEMINI_API_KEY,
  };
}

async function fetchModelCount(
  provider: ApiKeyProvider,
  apiKey: string,
): Promise<number | null> {
  switch (provider) {
    case "openai": {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) throw new Error(`OpenAI returned HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown[] };
      return body.data?.length ?? 0;
    }
    case "anthropic": {
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      });
      if (!res.ok) throw new Error(`Anthropic returned HTTP ${res.status}`);
      const body = (await res.json()) as { data?: unknown[] };
      return body.data?.length ?? 0;
    }
    case "google": {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Google returned HTTP ${res.status}`);
      const body = (await res.json()) as { models?: unknown[] };
      return body.models?.length ?? 0;
    }
  }
}
