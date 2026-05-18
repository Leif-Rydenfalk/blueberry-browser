import { v4 as uuidv4 } from "uuid";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentAction,
  AgentStep,
  AgentConfig,
  AgentContext,
  ActionResult,
  AgentStreamUpdate,
  TabStrategy,
} from "../types/AgentTypes";
import { buildReActPrompt } from "../prompts/systemPrompts";

export class AgentRunner {
  private config: AgentConfig;
  private strategy: TabStrategy;
  private llmClient: LLMClient;
  private steps: AgentStep[] = [];
  private isRunning = false;
  private isPaused = false;
  private abortController: AbortController | null = null;
  private pendingUserMessage: string | null = null;
  private onUpdate: ((update: AgentStreamUpdate) => void) | null = null;
  private onComplete: ((steps: AgentStep[]) => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private onNeedInput: ((question: string) => void) | null = null;

  constructor(config: AgentConfig, strategy: TabStrategy, llmClient: LLMClient) {
    this.config = config;
    this.strategy = strategy;
    this.llmClient = llmClient;
  }

  setCallbacks(
    onUpdate: (update: AgentStreamUpdate) => void,
    onComplete: (steps: AgentStep[]) => void,
    onError: (error: string) => void
  ): void {
    this.onUpdate = onUpdate;
    this.onComplete = onComplete;
    this.onError = onError;
  }

  async run(goal: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.steps = [];
    this.abortController = new AbortController();

    try {
      for (let stepNum = 0; stepNum < this.config.maxSteps; stepNum++) {
        if (this.abortController.signal.aborted) {
          console.log("[AgentRunner] Aborted by user");
          break;
        }

        // Check for user message - integrate into context
        if (this.pendingUserMessage) {
          goal = `${goal}\n\nUser says: ${this.pendingUserMessage}`;
          this.pendingUserMessage = null;
        }

        // Pause handling
        while (this.isPaused && !this.abortController.signal.aborted) {
          await this.sleep(200);
        }

        const context = await this.strategy.getActiveContext(goal, this.steps);
        const prompt = buildReActPrompt(context);

        this.emitUpdate({
          step: stepNum + 1,
          totalSteps: this.config.maxSteps,
          action: { type: "screenshot", params: {}, reasoning: "Analyzing page state" },
          status: "pending",
          sessionId: "",
        });

        const responseText = await this.llmClient.generateText(prompt);

        if (!responseText) {
          throw new Error("Failed to get response from LLM");
        }

        const action = this.parseActionFromResponse(responseText);
        if (!action) {
          console.error("[AgentRunner] Failed to parse action from:", responseText);
          throw new Error("Failed to parse valid action from LLM response");
        }

        this.emitUpdate({
          step: stepNum + 1,
          totalSteps: this.config.maxSteps,
          action,
          status: "running",
          sessionId: "",
        });

        const result = await this.strategy.executeAction(action);
        const screenshot = await this.strategy.captureScreenshot();

        const step: AgentStep = {
          id: uuidv4(),
          timestamp: Date.now(),
          action,
          result,
          screenshot: screenshot || undefined,
        };
        this.steps.push(step);

        this.emitUpdate({
          step: stepNum + 1,
          totalSteps: this.config.maxSteps,
          action,
          status: result.success ? "success" : "error",
          result,
          screenshot: screenshot || undefined,
          sessionId: "",
        });

        if (action.type === "finish") {
          console.log("[AgentRunner] Task completed");
          break;
        }

        await this.sleep(500);
      }

      this.onComplete?.(this.steps);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[AgentRunner] Error:", message);
      this.onError?.(message);
    } finally {
      this.isRunning = false;
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
    this.isRunning = false;
  }

  pause(): void {
    this.isPaused = true;
  }

  resume(): void {
    this.isPaused = false;
  }

  sendUserMessage(message: string): void {
    this.pendingUserMessage = message;
    // If agent is waiting/paused, this will be picked up in the loop
  }

  setNeedInputCallback(callback: (question: string) => void): void {
    this.onNeedInput = callback;
  }

  getSteps(): AgentStep[] {
    return [...this.steps];
  }

  isActive(): boolean {
    return this.isRunning;
  }

  private parseActionFromResponse(text: string): AgentAction | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error("[AgentRunner] No JSON found in response");
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!parsed.type || !parsed.params) {
        console.error("[AgentRunner] Invalid action format:", parsed);
        return null;
      }

      return {
        type: parsed.type,
        params: parsed.params,
        reasoning: parsed.reasoning || "No reasoning provided",
      };
    } catch (error) {
      console.error("[AgentRunner] JSON parse failed:", error);
      return null;
    }
  }

  private emitUpdate(update: AgentStreamUpdate): void {
    this.onUpdate?.(update);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}