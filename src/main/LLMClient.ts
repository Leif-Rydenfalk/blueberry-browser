import { WebContents } from "electron";
import { streamText, generateText, type LanguageModel, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import * as dotenv from "dotenv";
import { join } from "path";
import type { Window } from "./Window";

dotenv.config({ path: join(__dirname, "../../.env") });

interface ChatRequest {
  message: string;
  messageId: string;
}

interface StreamChunk {
  content: string;
  isComplete: boolean;
}

export type LLMProvider = "openai" | "anthropic";

export interface ModelOption {
  readonly provider: LLMProvider;
  readonly model: string;
  readonly label: string;
}

export interface ModelSelection extends ModelOption {
  readonly configured: boolean;
}

const MAX_CONTEXT_LENGTH = 4000;
const DEFAULT_TEMPERATURE = 0.7;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const ANTHROPIC_VERSION = "2023-06-01";

export class LLMClient {
  private readonly webContents: WebContents;
  private window: Window | null = null;
  private provider: LLMProvider;
  private modelName: string;
  public model: LanguageModel | null;
  private messages: CoreMessage[] = [];
  private modelOptions: ModelOption[] | null = null;
  private modelOptionsFetchedAt = 0;

  constructor(webContents: WebContents) {
    this.webContents = webContents;
    this.provider = this.getProvider();
    this.modelName = this.getModelName();
    this.model = this.initializeModel(this.provider, this.modelName);
    this.logInitializationStatus();
  }

  setWindow(window: Window): void {
    this.window = window;
  }

  private getProvider(): LLMProvider {
    const provider = process.env.LLM_PROVIDER?.toLowerCase();
    if (provider === "anthropic") return "anthropic";
    return "openai";
  }

  private getModelName(): string {
    return process.env.LLM_MODEL || "";
  }

  private initializeModel(provider: LLMProvider, modelName: string): LanguageModel | null {
    const apiKey = this.getApiKey(provider);
    if (!apiKey || !modelName) return null;

    switch (provider) {
      case "anthropic":
        return anthropic(modelName);
      case "openai":
        return openai(modelName);
      default:
        return null;
    }
  }

  private getApiKey(provider: LLMProvider = this.provider): string | undefined {
    switch (provider) {
      case "anthropic":
        return process.env.ANTHROPIC_API_KEY;
      case "openai":
        return process.env.OPENAI_API_KEY;
      default:
        return undefined;
    }
  }

  async getModelOptions(forceRefresh = false): Promise<readonly ModelOption[]> {
    const now = Date.now();
    if (!forceRefresh && this.modelOptions && now - this.modelOptionsFetchedAt < MODEL_CACHE_TTL_MS) {
      return this.withCurrentModelOption(this.modelOptions);
    }

    const results = await Promise.all([
      this.fetchOpenAIModels(),
      this.fetchAnthropicModels(),
    ]);

    this.modelOptions = results.flat();
    this.modelOptionsFetchedAt = now;

    if (!this.model && this.modelOptions.length > 0) {
      const preferred = this.selectPreferredModel(this.modelOptions, this.provider) || this.modelOptions[0];
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
      candidate => candidate.provider === this.provider && candidate.model === this.modelName
    );

    return {
      provider: this.provider,
      model: this.modelName,
      label: option?.label || this.getModelLabel(this.provider, this.modelName),
      configured: Boolean(this.model),
    };
  }

  async setModelSelection(provider: LLMProvider, modelName: string): Promise<ModelSelection> {
    this.applyModelSelection(provider, modelName);
    return this.getModelSelection();
  }

  private applyModelSelection(provider: LLMProvider, modelName: string): void {
    const nextModel = this.initializeModel(provider, modelName);
    if (!nextModel) {
      const keyName = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      throw new Error(`${keyName} is not configured.`);
    }

    this.provider = provider;
    this.modelName = modelName;
    this.model = nextModel;
    this.logInitializationStatus();
  }

  private getProviderLabel(provider: LLMProvider): string {
    return provider === "anthropic" ? "Claude" : "OpenAI";
  }

  private getModelLabel(provider: LLMProvider, modelName: string): string {
    return modelName ? `${this.getProviderLabel(provider)} · ${modelName}` : `${this.getProviderLabel(provider)} · No model selected`;
  }

  private withCurrentModelOption(options: readonly ModelOption[]): readonly ModelOption[] {
    if (!this.modelName) return options;
    if (options.some(option => option.provider === this.provider && option.model === this.modelName)) {
      return options;
    }

    return [
      { provider: this.provider, model: this.modelName, label: this.getModelLabel(this.provider, this.modelName) },
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
        console.error(`[LLMClient] OpenAI model list failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const payload = await response.json() as { data?: Array<{ id: string; created?: number }> };
      return (payload.data || [])
        .filter(model => this.isOpenAIGenerationModel(model.id))
        .sort((a, b) => this.compareOpenAIModels(a, b))
        .map(model => ({
          provider: "openai" as const,
          model: model.id,
          label: `OpenAI · ${model.id}`,
        }));
    } catch (error) {
      console.error("[LLMClient] OpenAI model list failed:", error);
      return [];
    }
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
        console.error(`[LLMClient] Anthropic model list failed: ${response.status} ${response.statusText}`);
        return [];
      }

      const payload = await response.json() as { data?: Array<{ id: string; display_name?: string; created_at?: string }> };
      return (payload.data || [])
        .filter(model => model.id.toLowerCase().includes("claude"))
        .sort((a, b) => this.compareAnthropicModels(a, b))
        .map(model => ({
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
    return !excludedTerms.some(term => id.includes(term));
  }

  private compareOpenAIModels(
    a: { id: string; created?: number },
    b: { id: string; created?: number }
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
    b: { id: string; created_at?: string }
  ): number {
    const scoreDiff = this.scoreAnthropicModel(b.id) - this.scoreAnthropicModel(a.id);
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

  private selectPreferredModel(options: readonly ModelOption[], provider: LLMProvider): ModelOption | null {
    return options.find(option => option.provider === provider) || options[0] || null;
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
        `✅ LLM Client initialized with ${this.provider} provider using model: ${this.modelName}`
      );
    } else {
      const keyName =
        this.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
      console.error(
        `❌ LLM Client initialization failed: ${keyName} not found in environment variables.\n` +
        `Please add your API key to the .env file in the project root.`
      );
    }
  }

  async sendChatMessage(request: ChatRequest): Promise<void> {
    try {
      let screenshot: string | null = null;
      if (this.window) {
        const activeTab = this.window.activeTab;
        if (activeTab) {
          try {
            const image = await activeTab.screenshot();
            screenshot = image.toDataURL();
          } catch (error) {
            console.error("Failed to capture screenshot:", error);
          }
        }
      }

      const userContent: any[] = [];
      if (screenshot) {
        userContent.push({
          type: "image",
          image: screenshot,
        });
      }
      userContent.push({
        type: "text",
        text: request.message,
      });

      const userMessage: CoreMessage = {
        role: "user",
        content: userContent.length === 1 ? request.message : userContent,
      };

      this.messages.push(userMessage);
      this.sendMessagesToRenderer();

      if (!this.model) {
        await this.getModelOptions();
      }

      if (!this.model) {
        this.sendErrorMessage(
          request.messageId,
          "LLM service is not configured. Please add an OpenAI or Anthropic API key to the .env file."
        );
        return;
      }

      const messages = await this.prepareMessagesWithContext(request);
      await this.streamResponse(messages, request.messageId);
    } catch (error) {
      console.error("Error in LLM request:", error);
      this.handleStreamError(error, request.messageId);
    }
  }

  async generateText(prompt: string, temperature?: number): Promise<string | null> {
    if (!this.model) {
      await this.getModelOptions();
    }
    if (!this.model) return this.buildAgentErrorResponse("LLM service is not configured. Please add an OpenAI or Anthropic API key to the .env file.");
    try {
      const options: any = {
        model: this.model,
        prompt,
        system: "You are a browser automation agent. Respond with JSON only.",
        maxRetries: 2,
      };
      if (temperature !== undefined) {
        options.temperature = temperature;
      }
      const result = await generateText(options);
      return result.text;
    } catch (error) {
      console.error("[LLMClient] generateText failed:", error);
      return this.buildAgentErrorResponse(this.getErrorMessage(error));
    }
  }

  async generateVisionText(prompt: string, imageBase64: string, temperature?: number): Promise<string | null> {
    if (!this.model) {
      await this.getModelOptions();
    }
    if (!this.model) return this.buildAgentErrorResponse("LLM service is not configured. Please add an OpenAI or Anthropic API key to the .env file.");
    try {
      const messages: any[] = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image", image: imageBase64 },
          ],
        },
      ];

      const options: any = {
        model: this.model,
        messages,
        maxRetries: 2,
      };
      if (temperature !== undefined) {
        options.temperature = temperature;
      }

      const result = await generateText(options);
      return result.text;
    } catch (error) {
      console.error("[LLMClient] generateVisionText failed:", error);
      if (this.isProviderOverloaded(error) || this.isRateLimited(error)) {
        return this.buildAgentErrorResponse(this.getErrorMessage(error));
      }

      // Fallback to text-only when only the vision request failed.
      return this.generateText(prompt, temperature);
    }
  }

  clearMessages(): void {
    this.messages = [];
    this.sendMessagesToRenderer();
  }

  getMessages(): CoreMessage[] {
    return this.messages;
  }

  private sendMessagesToRenderer(): void {
    this.webContents.send("chat-messages-updated", this.messages);
  }

  private async prepareMessagesWithContext(_request: ChatRequest): Promise<CoreMessage[]> {
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

    const systemContent = this.buildSystemPrompt(pageUrl, pageText);

    return [
      { role: "system", content: systemContent },
      ...this.messages
    ];
  }

  private buildSystemPrompt(url: string | null, pageText: string | null): string {
    const parts: string[] = [
      "You are a helpful AI assistant integrated into a web browser.",
      "You can analyze and discuss web pages with the user.",
      "The user's messages may include screenshots of the current page as the first image.",
    ];

    if (url) {
      parts.push(`\nCurrent page URL: ${url}`);
    }

    if (pageText) {
      const truncatedText = this.truncateText(pageText, MAX_CONTEXT_LENGTH);
      parts.push(`\nPage content (text):\n${truncatedText}`);
    }

    parts.push(
      "\nPlease provide helpful, accurate, and contextual responses about the current webpage.",
      "If the user asks about specific content, refer to the page content and/or screenshot provided."
    );

    return parts.join("\n");
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + "...";
  }

  private async streamResponse(
    messages: CoreMessage[],
    messageId: string
  ): Promise<void> {
    if (!this.model) {
      await this.getModelOptions();
    }

    if (!this.model) {
      throw new Error("Model not initialized");
    }

    const systemContent = messages[0].role === "system" ? messages[0].content as string : undefined;
    const chatMessages = messages[0].role === "system" ? messages.slice(1) : messages;

    try {
      const result = await streamText({
        model: this.model,
        system: systemContent,
        messages: chatMessages,
        temperature: DEFAULT_TEMPERATURE,
        maxRetries: 3,
      });

      await this.processStream(result.textStream, messageId);
    } catch (error) {
      throw error;
    }
  }

  private async processStream(
    textStream: AsyncIterable<string>,
    messageId: string
  ): Promise<void> {
    let accumulatedText = "";

    const assistantMessage: CoreMessage = {
      role: "assistant",
      content: "",
    };

    const messageIndex = this.messages.length;
    this.messages.push(assistantMessage);

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
      return "Authentication error: Please check your API key in the .env file.";
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
    return this.errorText(error).includes("429") || this.errorText(error).includes("rate limit");
  }

  private isProviderOverloaded(error: unknown): boolean {
    const text = this.errorText(error);
    return text.includes("529") || text.includes("overloaded") || text.includes("overloaded_error");
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
    this.webContents.send("chat-response", {
      messageId,
      content: chunk.content,
      isComplete: chunk.isComplete,
    });
  }
}
