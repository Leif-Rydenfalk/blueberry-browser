import { WebContents } from "electron";
import {
  streamText,
  generateText as generateAIText,
  type LanguageModel,
  type CoreMessage,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import * as dotenv from "dotenv";
import { join } from "path";
import type { Window } from "./Window";
import type { TokenUsageStore, TokenUsageTotals } from "./TokenUsageStore";
import type { SettingsStore } from "./Settings/SettingsStore";
import type { ApiKeyProvider } from "./Settings/SettingsTypes";

dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

export type LLMProvider = "openai" | "anthropic" | "google";

export interface ModelOption {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly label: string;
}

export interface ModelSelection extends ModelOption {
  readonly configured: boolean;
}

const MAX_PAGE_CONTEXT_LENGTH = 6500;
const MAX_PAGE_EXCERPT_LENGTH = 4200;
const MAX_RECENT_CHAT_MESSAGES = 8;
const MAX_MESSAGE_TEXT_LENGTH = 2400;
const COMPACT_AFTER_MESSAGE_COUNT = 12;
const CONVERSATION_SUMMARY_MAX_LENGTH = 2200;
const SUMMARY_SOURCE_MAX_LENGTH = 12000;
const DEFAULT_TEMPERATURE = 0.7;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private provider: LLMProvider;
  private modelName: string;
  private model: LanguageModel | null;
  private messages: CoreMessage[] = [];
  private conversationSummary = "";
  private summarizedMessageCount = 0;
  private modelOptions: ModelOption[] | null = null;
  private modelOptionsFetchedAt = 0;
  private usageStore: TokenUsageStore | null = null;
  private settingsStore: SettingsStore | null = null;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel(this.provider, this.modelName);
    this.logInitializationStatus();
  }

  setSettingsStore(store: SettingsStore): void {
    this.settingsStore = store;
    // Replay last-used selection if present and we can configure it.
    const last = store.getLastModel();
    if (last) {
      const nextModel = this.initializeModel(last.provider, last.model);
      if (nextModel) {
        this.provider = last.provider;
        this.modelName = last.model;
        this.model = nextModel;
        this.modelOptions = null;
        this.logInitializationStatus();
        return;
      }
    }
    // Otherwise just re-evaluate the current selection in case a UI-saved key
    // now makes it work.
    this.model = this.initializeModel(this.provider, this.modelName);
    this.logInitializationStatus();
  }

  // Called by SettingsIpcHandler after the user pastes / clears a key. The
  // current selection is re-evaluated; the picker UI refreshes via getModelOptions.
  async refreshFromSettings(): Promise<void> {
    this.model = this.initializeModel(this.provider, this.modelName);
    this.modelOptions = null;
    this.modelOptionsFetchedAt = 0;
    this.logInitializationStatus();
    // Eagerly refresh model options so the picker reflects the new key state.
    void this.getModelOptions(true).catch((err) => {
      console.error("[LLMClient] refreshFromSettings: model fetch failed:", err);
    });
  }

  setUsageStore(store: TokenUsageStore): void {
    this.usageStore = store;
  }

  getTokenUsage(): TokenUsageTotals | null {
    return this.usageStore?.getTotals() ?? null;
  }

  private sendIpc(channel: string, payload: unknown): void {
    if (this.webContents.isDestroyed()) return;
    this.webContents.send(channel, payload);
  }

  private recordUsage(inputTokens: number, outputTokens: number): void {
    if (!this.usageStore) return;
    // Fire-and-forget: persist errors are logged inside the store. Totals
    // are updated in-memory synchronously so the IPC payload is consistent.
    void this.usageStore.record(inputTokens, outputTokens);
    this.sendIpc("token-usage-updated", this.usageStore.getTotals());
  }

  getModel(): LanguageModel | null {
    return this.model;
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    if (provider === "anthropic") return "anthropic";
    if (provider === "google" || provider === "gemini") return "google";
    return "openai";
  }

  private getModelName(): string {
    return process.env.LLM_MODEL || "";
  }

  private initializeModel(
    provider: LLMProvider,
    modelName: string,
  ): LanguageModel | null {
    const apiKey = this.getApiKey(provider);
    if (!apiKey || !modelName) return null;

    switch (provider) {
      case "anthropic":
        return createAnthropic({ apiKey })(modelName);
      case "openai":
        return createOpenAI({ apiKey })(modelName);
      case "google":
        return createGoogleGenerativeAI({ apiKey })(modelName);
      default:
        return null;
    }
  }

  // Resolution order: UI-saved key (SettingsStore) wins over .env. This means
  // a desktop user who pastes a key in the settings modal can confidently
  // override whatever was in the dev .env file.
  private getApiKey(provider: LLMProvider = this.provider): string | undefined {
    const stored = this.settingsStore?.getApiKey(provider as ApiKeyProvider);
    if (stored) return stored;
    switch (provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "openai":
        return process.env.OPENAI_API_KEY;
      case "google":
        return (
          process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
          process.env.GOOGLE_API_KEY ??
          process.env.GEMINI_API_KEY
        );
      default:
        return undefined;
    }
  }

  async getModelOptions(forceRefresh = false): Promise<readonly ModelOption[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.modelOptions &&
      now - this.modelOptionsFetchedAt < MODEL_CACHE_TTL_MS
    ) {
      return this.withCurrentModelOption(this.modelOptions);
    }

    const results = await Promise.all([
      this.fetchOpenAIModels(),
      this.fetchAnthropicModels(),
      this.fetchGoogleModels(),
    ]);

    this.modelOptions = results.flat();
    this.modelOptionsFetchedAt = now;

    if (!this.model && this.modelOptions.length > 0) {
      const preferred =
        this.selectPreferredModel(this.modelOptions, this.provider) ||
        this.modelOptions[0];
      this.applyModelSelection(preferred.provider, preferred.model);
    }

    return this.withCurrentModelOption(this.modelOptions);
  }

  async getModelSelection(): Promise<ModelSelection> {
    if (!this.model) {
      await this.getModelOptions();
    }

    const options = await this.getModelOptions();
    const option = options.find(
      (candidate) =>
        candidate.provider === this.provider &&
        candidate.model === this.modelName,
    );

    return {
      provider: this.provider,
      model: this.modelName,
      label: option?.label || this.getModelLabel(this.provider, this.modelName),
      configured: Boolean(this.model),
    };
  }

  async setModelSelection(
    provider: LLMProvider,
    modelName: string,
  ): Promise<ModelSelection> {
    this.applyModelSelection(provider, modelName);
    return this.getModelSelection();
  }

  private applyModelSelection(provider: LLMProvider, modelName: string): void {
    const nextModel = this.initializeModel(provider, modelName);
    if (!nextModel) {
      throw new Error(`${this.getApiKeyName(provider)} is not configured.`);
    }

    this.provider = provider;
    this.modelName = modelName;
    this.model = nextModel;
    void this.settingsStore?.setLastModel({
      provider: provider as ApiKeyProvider,
      model: modelName,
    });
    this.logInitializationStatus();
  }

  private getProviderLabel(provider: LLMProvider): string {
    switch (provider) {
      case "anthropic":
        return "Claude";
      case "google":
        return "Gemini";
      case "openai":
      default:
        return "OpenAI";
    }
  }

  private getApiKeyName(provider: LLMProvider): string {
    switch (provider) {
      case "anthropic":
        return "ANTHROPIC_API_KEY";
      case "google":
        return "GOOGLE_GENERATIVE_AI_API_KEY";
      case "openai":
      default:
        return "OPENAI_API_KEY";
    }
  }

  private getModelLabel(provider: LLMProvider, modelName: string): string {
    return modelName
      ? `${this.getProviderLabel(provider)} · ${modelName}`
      : `${this.getProviderLabel(provider)} · No model selected`;
  }

  private withCurrentModelOption(
    options: readonly ModelOption[],
  ): readonly ModelOption[] {
    if (!this.modelName) return options;
    if (
      options.some(
        (option) =>
          option.provider === this.provider && option.model === this.modelName,
      )
    ) {
      return options;
    }

    return [
      {
        provider: this.provider,
        model: this.modelName,
        label: this.getModelLabel(this.provider, this.modelName),
      },
      ...options,
    ];
  }

  private async fetchOpenAIModels(): Promise<ModelOption[]> {
    const apiKey = this.getApiKey("openai");
    if (!apiKey) return [];

    try {
      const response = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) {
        console.error(
          `[LLMClient] OpenAI model list failed: ${response.status} ${response.statusText}`,
        );
        return [];
      }

      const payload = (await response.json()) as {
        data?: Array<{ id: string; created?: number }>;
      };
      return (payload.data || [])
        .filter((model) => this.isOpenAIGenerationModel(model.id))
        .sort((a, b) => this.compareOpenAIModels(a, b))
        .map((model) => ({
          provider: "openai" as const,
          model: model.id,
          label: `OpenAI · ${model.id}`,
        }));
    } catch (error) {
      console.error("[LLMClient] OpenAI model list failed:", error);
      return [];
    }
  }

  private async fetchGoogleModels(): Promise<ModelOption[]> {
    const apiKey = this.getApiKey("google");
    if (!apiKey) return [];

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.error(
          `[LLMClient] Google model list failed: ${response.status} ${response.statusText}`,
        );
        return [];
      }

      const payload = (await response.json()) as {
        models?: Array<{
          name: string;
          displayName?: string;
          supportedGenerationMethods?: string[];
        }>;
      };
      return (payload.models || [])
        .filter((model) => this.isGoogleGenerationModel(model))
        .map((model) => ({
          id: stripGoogleModelPrefix(model.name),
          displayName: model.displayName,
        }))
        .sort((a, b) => this.compareGoogleModels(a, b))
        .map((model) => ({
          provider: "google" as const,
          model: model.id,
          label: `Gemini · ${model.displayName || model.id}`,
        }));
    } catch (error) {
      console.error("[LLMClient] Google model list failed:", error);
      return [];
    }
  }

  private isGoogleGenerationModel(model: {
    name: string;
    supportedGenerationMethods?: string[];
  }): boolean {
    const id = stripGoogleModelPrefix(model.name).toLowerCase();
    if (!id.startsWith("gemini")) return false;
    // Skip embeddings, image-only, etc. — keep models that can do text generation.
    const methods = model.supportedGenerationMethods ?? [];
    if (methods.length > 0 && !methods.includes("generateContent")) return false;
    const excluded = ["embedding", "aqa", "vision-tuning"];
    return !excluded.some((term) => id.includes(term));
  }

  private compareGoogleModels(
    a: { id: string; displayName?: string },
    b: { id: string; displayName?: string },
  ): number {
    return this.scoreGoogleModel(b.id) - this.scoreGoogleModel(a.id);
  }

  private scoreGoogleModel(modelId: string): number {
    const id = modelId.toLowerCase();
    let score = this.extractGoogleModelVersion(id) * 100;
    if (id.includes("pro")) score += 30;
    if (id.includes("flash")) score += 20;
    if (id.includes("lite")) score -= 10;
    if (id.includes("preview")) score -= 5;
    if (id.includes("exp")) score -= 8;
    return score;
  }

  private extractGoogleModelVersion(value: string): number {
    const match = value.match(/gemini-(\d+(?:[-.]\d+)?)/);
    if (!match) return 0;
    return this.parseModelVersion(match[1]);
  }

  private async fetchAnthropicModels(): Promise<ModelOption[]> {
    const apiKey = this.getApiKey("anthropic");
    if (!apiKey) return [];

    try {
      const response = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
      });
      if (!response.ok) {
        console.error(
          `[LLMClient] Anthropic model list failed: ${response.status} ${response.statusText}`,
        );
        return [];
      }

      const payload = (await response.json()) as {
        data?: Array<{
          id: string;
          display_name?: string;
          created_at?: string;
        }>;
      };
      return (payload.data || [])
        .filter((model) => model.id.toLowerCase().includes("claude"))
        .sort((a, b) => this.compareAnthropicModels(a, b))
        .map((model) => ({
          provider: "anthropic" as const,
          model: model.id,
          label: `Claude · ${model.display_name || model.id}`,
        }));
    } catch (error) {
      console.error("[LLMClient] Anthropic model list failed:", error);
      return [];
    }
  }

  private isOpenAIGenerationModel(modelId: string): boolean {
    const id = modelId.toLowerCase();
    if (!id.startsWith("gpt-") && !/^o\d/.test(id)) return false;

    const excludedTerms = [
      "audio",
      "realtime",
      "transcribe",
      "tts",
      "whisper",
      "embedding",
      "moderation",
      "image",
      "search-preview",
    ];
    return !excludedTerms.some((term) => id.includes(term));
  }

  private compareOpenAIModels(
    a: { id: string; created?: number },
    b: { id: string; created?: number },
  ): number {
    const scoreDiff = this.scoreOpenAIModel(b.id) - this.scoreOpenAIModel(a.id);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.created || 0) - (a.created || 0);
  }

  private scoreOpenAIModel(modelId: string): number {
    const id = modelId.toLowerCase();
    let score = id.startsWith("gpt-") ? 10000 : 5000;
    score += this.extractOpenAIModelVersion(id) * 100;
    if (id.includes("mini")) score -= 40;
    if (id.includes("nano")) score -= 60;
    if (id.includes("preview")) score -= 10;
    return score;
  }

  private compareAnthropicModels(
    a: { id: string; created_at?: string },
    b: { id: string; created_at?: string },
  ): number {
    const scoreDiff =
      this.scoreAnthropicModel(b.id) - this.scoreAnthropicModel(a.id);
    if (scoreDiff !== 0) return scoreDiff;
    return Date.parse(b.created_at || "") - Date.parse(a.created_at || "");
  }

  private scoreAnthropicModel(modelId: string): number {
    const id = modelId.toLowerCase();
    let score = this.extractAnthropicModelVersion(id) * 100;
    if (id.includes("opus")) score += 50;
    if (id.includes("sonnet")) score += 30;
    if (id.includes("haiku")) score += 10;
    return score;
  }

  private selectPreferredModel(
    options: readonly ModelOption[],
    provider: LLMProvider,
  ): ModelOption | null {
    return (
      options.find((option) => option.provider === provider) ||
      options[0] ||
      null
    );
  }

  private extractOpenAIModelVersion(value: string): number {
    const match = value.match(/(?:gpt-|^o)(\d+(?:[-.]\d+)?)/);
    if (!match) return 0;
    return this.parseModelVersion(match[1]);
  }

  private extractAnthropicModelVersion(value: string): number {
    const match = value.match(/claude-[a-z]+-(\d+(?:[-.]\d+)?)/);
    if (!match) return 0;
    return this.parseModelVersion(match[1]);
  }

  private parseModelVersion(value: string): number {
    const numeric = Number(value.replace("-", "."));
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private logInitializationStatus(): void {
    if (this.model) {
      console.log(
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`,
      );
    } else {
      console.error(
        `❌ LLM Client initialization failed: ${this.getApiKeyName(this.provider)} not configured.\n` +
          `Add it in Blueberry's Settings panel, or set it in the .env file.`,
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    if (
      typeof request?.message !== "string" ||
      typeof request?.messageId !== "string" ||
      !request.message.trim()
    ) {
      console.error("[LLMClient] sendChatMessage: invalid request payload");
      return;
    }

    try {
      let screenshot: string | null = null;
      if (this.window) {
        const activeTab = this.window.activeTab;
        if (activeTab) {
          try {
            const image = await activeTab.screenshot({ maxWidth: 800 });
            screenshot = image.toDataURL();
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
          }
        }
      }

      const userMessage: CoreMessage = {
        role: "user",
        content: request.message,
      };

      this.messages.push(userMessage);
      this.sendMessagesToRenderer();

      if (!this.model) {
        await this.getModelOptions();
      }

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Open the API key settings in the sidebar and paste a key for OpenAI, Anthropic, or Google.",
        );
        return;
      }

      await this.updateConversationSummary();

      const messages = await this.prepareMessagesWithContext(
        request,
        screenshot,
      );
      await this.streamResponse(messages, request.messageId);
    } catch (error) {
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    }
  }

  async generateText(
    prompt: string,
    temperature?: number,
    system?: string,
  ): Promise<string | null> {
    if (!this.model) {
      await this.getModelOptions();
    }
    if (!this.model)
      return this.buildAgentErrorResponse(
        "LLM service is not configured. Please add an OpenAI or Anthropic API key to the .env file.",
      );
    try {
      const resolvedSystem =
        system ?? "You are a browser automation agent. Respond with JSON only.";
      const result = await generateAIText({
        model: this.model,
        prompt,
        system: resolvedSystem,
        maxRetries: 2,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(this.provider === "anthropic" && system
          ? {
              providerOptions: {
                anthropic: { cacheControl: { type: "ephemeral" as const } },
              },
            }
          : {}),
      });
      this.recordUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0,
      );
      return result.text;
    } catch (error) {
      console.error("[LLMClient] generateText failed:", error);
      return this.buildAgentErrorResponse(this.getErrorMessage(error));
    }
  }

  async generateVisionText(
    prompt: string,
    imageBase64: string,
    temperature?: number,
    system?: string,
  ): Promise<string | null> {
    if (!this.model) {
      await this.getModelOptions();
    }
    if (!this.model)
      return this.buildAgentErrorResponse(
        "LLM service is not configured. Please add an OpenAI or Anthropic API key to the .env file.",
      );
    try {
      const resolvedSystem =
        system ?? "You are a browser automation agent. Respond with JSON only.";
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: imageBase64 },
          ],
        },
      ] as CoreMessage[];

      const result = await generateAIText({
        model: this.model,
        system: resolvedSystem,
        messages,
        maxRetries: 2,
        ...(temperature !== undefined ? { temperature } : {}),
        ...(this.provider === "anthropic" && system
          ? {
              providerOptions: {
                anthropic: { cacheControl: { type: "ephemeral" as const } },
              },
            }
          : {}),
      });
      this.recordUsage(
        result.usage.inputTokens ?? 0,
        result.usage.outputTokens ?? 0,
      );
      return result.text;
    } catch (error) {
      console.error("[LLMClient] generateVisionText failed:", error);
      if (this.isProviderOverloaded(error) || this.isRateLimited(error)) {
        return this.buildAgentErrorResponse(this.getErrorMessage(error));
      }

      // Fallback to text-only when only the vision request failed.
      return this.generateText(prompt, temperature, system);
    }
  }

  clearMessages(): void {
    this.messages = [];
    this.conversationSummary = "";
    this.summarizedMessageCount = 0;
    this.sendMessagesToRenderer();
  }

  getMessages(): readonly CoreMessage[] {
    return [...this.messages];
  }

  private sendMessagesToRenderer(): void {
    this.sendIpc("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(
    request: ChatRequest,
    screenshot: string | null,
  ): Promise<CoreMessage[]> {
    let pageUrl: string | null = null;
    let pageText: string | null = null;

    if (this.window) {
      const activeTab = this.window.activeTab;
      if (activeTab) {
        pageUrl = activeTab.url;
        try {
          pageText = await activeTab.getTabText();
        } catch (error) {
          console.error("Failed to get page text:", error);
        }
      }
    }

    const systemContent = this.buildSystemPrompt(
      pageUrl,
      pageText,
      request.message,
    );
    const requestMessages = this.buildModelFacingMessages(screenshot);

    return [{ role: "system", content: systemContent }, ...requestMessages];
  }

  private buildSystemPrompt(
    url: string | null,
    pageText: string | null,
    userMessage: string,
  ): string {
    const parts: string[] = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The latest user message may include one current-page screenshot.",
      "Use the conversation memory for durable context, and the recent messages for exact wording.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (this.conversationSummary) {
      parts.push(`\nConversation memory:\n${this.conversationSummary}`);
    }

    if (pageText) {
      const pageContext = this.extractRelevantPageText(
        pageText,
        userMessage,
        MAX_PAGE_EXCERPT_LENGTH,
      );
      parts.push(`\nRelevant page text:\n${pageContext}`);
    }

    parts.push(
      "\nPlease provide helpful, accurate, and contextual responses about the current webpage.",
      "If the user asks about specific content, refer to the page content and/or screenshot provided.",
    );

    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private buildModelFacingMessages(screenshot: string | null): CoreMessage[] {
    const recentMessages = this.messages.slice(-MAX_RECENT_CHAT_MESSAGES);
    const latestIndex = recentMessages.length - 1;

    return recentMessages
      .map((message, index) => {
        const text = this.truncateText(
          this.getMessageText(message),
          MAX_MESSAGE_TEXT_LENGTH,
        );
        const isLatestUserMessage =
          index === latestIndex && message.role === "user";

        if (isLatestUserMessage && screenshot) {
          return {
            role: "user",
            content: [
              { type: "image", image: screenshot },
              { type: "text", text },
            ],
          } as CoreMessage;
        }

        return {
          role: message.role,
          content: text,
        } as CoreMessage;
      })
      .filter((message) => this.getMessageText(message).trim().length > 0);
  }

  private async updateConversationSummary(): Promise<void> {
    if (this.messages.length < COMPACT_AFTER_MESSAGE_COUNT) return;

    const summarizeUntil = Math.max(
      0,
      this.messages.length - MAX_RECENT_CHAT_MESSAGES,
    );
    if (summarizeUntil <= this.summarizedMessageCount) return;

    const sourceMessages = this.messages.slice(
      this.summarizedMessageCount,
      summarizeUntil,
    );
    const sourceText = this.truncateText(
      this.formatMessagesForSummary(sourceMessages),
      SUMMARY_SOURCE_MAX_LENGTH,
    );
    if (!sourceText.trim()) {
      this.summarizedMessageCount = summarizeUntil;
      return;
    }

    if (!this.model) {
      this.conversationSummary = this.truncateText(
        [this.conversationSummary, sourceText].filter(Boolean).join("\n"),
        CONVERSATION_SUMMARY_MAX_LENGTH,
      );
      this.summarizedMessageCount = summarizeUntil;
      return;
    }

    try {
      const result = await generateAIText({
        model: this.model,
        system:
          "Summarize browser assistant conversation memory. Return concise plain text only.",
        prompt: [
          "Update the durable memory using the existing memory and new transcript.",
          "Keep user preferences, goals, decisions, facts discovered from pages, unresolved tasks, and important constraints.",
          "Drop greetings, repeated wording, screenshots, and transient progress chatter.",
          `Keep it under ${CONVERSATION_SUMMARY_MAX_LENGTH} characters.`,
          "",
          `Existing memory:\n${this.conversationSummary || "(none)"}`,
          "",
          `New transcript:\n${sourceText}`,
        ].join("\n"),
        temperature: 0.2,
        maxRetries: 1,
      });
      this.conversationSummary = this.truncateText(
        result.text.trim(),
        CONVERSATION_SUMMARY_MAX_LENGTH,
      );
      this.summarizedMessageCount = summarizeUntil;
    } catch (error) {
      console.error("[LLMClient] Conversation summarization failed:", error);
      const fallback = [this.conversationSummary, sourceText]
        .filter(Boolean)
        .join("\n");
      this.conversationSummary = this.truncateText(
        fallback,
        CONVERSATION_SUMMARY_MAX_LENGTH,
      );
      this.summarizedMessageCount = summarizeUntil;
    }
  }

  private formatMessagesForSummary(messages: readonly CoreMessage[]): string {
    return messages
      .map(
        (message) =>
          `${message.role}: ${this.truncateText(this.getMessageText(message), 1200)}`,
      )
      .filter((line) => line.trim().length > 0)
      .join("\n");
  }

  private getMessageText(message: CoreMessage): string {
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";

    return content
      .map((part) => {
        if (
          part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part
        ) {
          return String(part.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private extractRelevantPageText(
    pageText: string,
    query: string,
    maxLength: number,
  ): string {
    const normalized = this.normalizeWhitespace(pageText);
    if (normalized.length <= maxLength) return normalized;

    const terms = this.getQueryTerms(query);
    if (terms.length === 0) {
      return this.truncateText(
        normalized,
        Math.min(MAX_PAGE_CONTEXT_LENGTH, maxLength),
      );
    }

    const paragraphs = normalized
      .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const scored = paragraphs
      .map((paragraph, index) => ({
        paragraph,
        index,
        score: this.scorePageParagraph(paragraph, terms),
      }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, 12)
      .sort((a, b) => a.index - b.index);

    const selected =
      scored.length > 0
        ? scored.map((item) => item.paragraph).join("\n\n")
        : normalized;

    return this.truncateText(selected, maxLength);
  }

  private normalizeWhitespace(text: string): string {
    return text
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  private getQueryTerms(query: string): string[] {
    const stopWords = new Set([
      "about",
      "after",
      "again",
      "also",
      "and",
      "any",
      "are",
      "can",
      "could",
      "for",
      "from",
      "have",
      "how",
      "into",
      "please",
      "show",
      "tell",
      "that",
      "the",
      "this",
      "was",
      "what",
      "when",
      "where",
      "which",
      "with",
      "you",
      "your",
    ]);

    return Array.from(
      new Set(query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []),
    ).filter((term) => !stopWords.has(term));
  }

  private scorePageParagraph(
    paragraph: string,
    terms: readonly string[],
  ): number {
    const lower = paragraph.toLowerCase();
    return terms.reduce((score, term) => {
      const occurrences = lower.split(term).length - 1;
      return score + occurrences * Math.min(term.length, 12);
    }, 0);
  }

  private async streamResponse(
    messages: CoreMessage[],
    messageId: string,
  ): Promise<void> {
    if (!this.model) {
      await this.getModelOptions();
    }

    if (!this.model) {
      throw new Error("Model not initialized");
    }

    const systemContent =
      messages[0].role === "system"
        ? (messages[0].content as string)
        : undefined;
    const chatMessages =
      messages[0].role === "system" ? messages.slice(1) : messages;

    const result = await streamText({
      model: this.model,
      system: systemContent,
      messages: chatMessages,
      temperature: DEFAULT_TEMPERATURE,
      maxRetries: 3,
    });

    await this.processStream(result.textStream, messageId);

    try {
      const usage = await result.usage;
      this.recordUsage(usage.inputTokens ?? 0, usage.outputTokens ?? 0);
    } catch (error) {
      console.error("[LLMClient] Failed to read stream usage:", error);
    }
  }

  private async processStream(
    textStream: AsyncIterable<string>,
    messageId: string,
  ): Promise<void> {
    let accumulatedText = "";

    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: "",
    };

    const messageIndex = this.messages.length;
    this.messages.push(assistantMessage);

    try {
      for await (const chunk of textStream) {
        accumulatedText += chunk;

        this.messages[messageIndex] = {
          role: "assistant",
          content: accumulatedText,
        };
        this.sendMessagesToRenderer();

        this.sendStreamChunk(messageId, {
          content: chunk,
          isComplete: false,
        });
      }
    } catch (error) {
      // Remove the partial placeholder so it doesn't poison future turns.
      this.messages.splice(messageIndex, 1);
      throw error;
    }

    this.messages[messageIndex] = {
      role: "assistant",
      content: accumulatedText,
    };
    this.sendMessagesToRenderer();

    this.sendStreamChunk(messageId, {
      content: accumulatedText,
      isComplete: true,
    });
  }

  private handleStreamError(error: unknown, messageId: string): void {
    console.error("Error streaming from LLM:", error);

    const errorMessage = this.getErrorMessage(error);
    this.sendErrorMessage(messageId, errorMessage);
  }

  private getErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
      return "An unexpected error occurred. Please try again.";
    }

    const message = error.message.toLowerCase();

    if (message.includes("401") || message.includes("unauthorized")) {
      return "Authentication error: Please check your API key in Blueberry's settings (or the .env file).";
    }

    if (message.includes("429") || message.includes("rate limit")) {
      return "Rate limit exceeded. Please try again in a few moments.";
    }

    if (
      message.includes("529") ||
      message.includes("overloaded") ||
      message.includes("overloaded_error")
    ) {
      return "The model provider is overloaded right now. Please try again in a moment.";
    }

    if (
      message.includes("network") ||
      message.includes("fetch") ||
      message.includes("econnrefused")
    ) {
      return "Network error: Please check your internet connection.";
    }

    if (message.includes("timeout")) {
      return "Request timeout: The service took too long to respond. Please try again.";
    }

    return "Sorry, I encountered an error while processing your request. Please try again.";
  }

  private isRateLimited(error: unknown): boolean {
    return (
      this.errorText(error).includes("429") ||
      this.errorText(error).includes("rate limit")
    );
  }

  private isProviderOverloaded(error: unknown): boolean {
    const text = this.errorText(error);
    return (
      text.includes("529") ||
      text.includes("overloaded") ||
      text.includes("overloaded_error")
    );
  }

  private errorText(error: unknown): string {
    if (error instanceof Error) {
      const details = JSON.stringify(error, Object.getOwnPropertyNames(error));
      return `${error.message} ${details}`.toLowerCase();
    }
    try {
      return JSON.stringify(error).toLowerCase();
    } catch {
      return String(error).toLowerCase();
    }
  }

  private buildAgentErrorResponse(message: string): string {
    return JSON.stringify({
      type: "finish",
      params: { answer: message },
      reasoning: "LLM provider error",
    });
  }

  private sendErrorMessage(messageId: string, errorMessage: string): void {
    this.sendStreamChunk(messageId, {
      content: errorMessage,
      isComplete: true,
    });
  }

  private sendStreamChunk(messageId: string, chunk: StreamChunk): void {
    this.sendIpc("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }
}

function stripGoogleModelPrefix(name: string): string {
  // The Generative Language API returns `models/gemini-...`; the SDK wants
  // the bare id.
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}
