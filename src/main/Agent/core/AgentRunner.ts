import { v4 as uuidv4 } from "uuid";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentAction,
  AgentStep,
  AgentConfig,
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
  private workingMemory: string[] = [];
  private onUpdate: ((update: AgentStreamUpdate) => void) | null = null;
  private onComplete: ((steps: AgentStep[]) => void) | null = null;
  private onError: ((error: string) => void) | null = null;

  constructor(
    config: AgentConfig,
    strategy: TabStrategy,
    llmClient: LLMClient,
  ) {
    this.config = config;
    this.strategy = strategy;
    this.llmClient = llmClient;
  }

  setCallbacks(
    onUpdate: (update: AgentStreamUpdate) => void,
    onComplete: (steps: AgentStep[]) => void,
    onError: (error: string) => void,
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
    this.workingMemory = [];
    this.abortController = new AbortController();

    try {
      let consecutiveErrors = 0;
      let repeatedActionCount = 0;
      let previousActionSignature = "";
      let finished = false;
      const startTime = Date.now();
      let stepNum = 0;
      while (stepNum < this.config.maxSteps) {
        stepNum++;

        // Check max duration
        if (
          this.config.maxDurationMs &&
          Date.now() - startTime > this.config.maxDurationMs
        ) {
          console.log("[AgentRunner] Max duration reached, finishing");
          finished = true;
          this.emitUpdate({
            step: stepNum,
            totalSteps: this.config.maxSteps,
            action: {
              type: "finish",
              params: {
                answer: `Task ran for ${this.config.maxDurationMs / 60000} minutes. Completed ${stepNum} steps.`,
              },
              reasoning: "Max duration reached",
            },
            status: "success",
            sessionId: "",
          });
          break;
        }
        if (this.abortController.signal.aborted) {
          console.log("[AgentRunner] Aborted by user");
          break;
        }

        // Check for user message - integrate into context
        if (this.pendingUserMessage) {
          goal = `${goal}\n\nUser says: ${this.pendingUserMessage}`;
          this.remember(`User update: ${this.pendingUserMessage}`);
          this.pendingUserMessage = null;
        }

        // Pause handling
        while (this.isPaused && !this.abortController.signal.aborted) {
          await this.sleep(200);
        }

        const elapsedMs = Date.now() - startTime;
        const context = {
          ...(await this.strategy.getActiveContext(goal, this.steps)),
          memory: this.buildWorkingMemory(),
          profile: this.config.taskProfile,
          loopMode: this.config.loopMode,
          stepBudget: this.config.maxSteps,
          elapsedMs,
          remainingMs: this.config.maxDurationMs
            ? Math.max(0, this.config.maxDurationMs - elapsedMs)
            : undefined,
        };

        this.emitUpdate({
          step: stepNum,
          totalSteps: this.config.maxSteps,
          action: {
            type: "screenshot",
            params: {},
            reasoning: "Analyzing page state",
          },
          status: "pending",
          sessionId: "",
        });

        // Build prompt with image if available
        const basePrompt = buildReActPrompt(context);

        let responseText: string | null;
        if (context.screenshot) {
          responseText = await this.llmClient.generateVisionText(
            basePrompt,
            context.screenshot,
          );
        } else {
          responseText = await this.llmClient.generateText(basePrompt);
        }

        if (!responseText) {
          throw new Error("Failed to get response from LLM");
        }

        const action = this.parseActionFromResponse(responseText);
        if (!action) {
          console.error(
            "[AgentRunner] Failed to parse action from:",
            responseText,
          );
          throw new Error("Failed to parse valid action from LLM response");
        }
        const actionSignature = this.getActionSignature(action);
        repeatedActionCount =
          actionSignature === previousActionSignature
            ? repeatedActionCount + 1
            : 1;
        previousActionSignature = actionSignature;

        if (this.config.loopMode && repeatedActionCount >= 10) {
          this.remember(
            `Repeated ${action.type} ${repeatedActionCount} times; inspect the current page and vary the approach if progress stalls.`,
          );
        }

        this.emitUpdate({
          step: stepNum,
          totalSteps: this.config.maxSteps,
          action,
          status: "running",
          sessionId: "",
        });

        const result = await this.strategy.executeAction(action);
        const afterScreenshot = await this.strategy.captureScreenshot();
        this.updateWorkingMemory(action, result);

        const step: AgentStep = {
          id: uuidv4(),
          timestamp: Date.now(),
          action,
          result,
          screenshot: afterScreenshot || undefined,
        };
        this.steps.push(step);

        this.emitUpdate({
          step: stepNum,
          totalSteps: this.config.maxSteps,
          action,
          status: result.success ? "success" : "error",
          result,
          screenshot: afterScreenshot || context.screenshot || undefined,
          sessionId: "",
        });

        if (action.type === "finish") {
          console.log("[AgentRunner] Task completed");
          finished = true;
          break;
        }

        // Force finish if stuck in an error loop. Long-running tasks get more room
        // to recover because social feeds and inboxes often have transient failures.
        if (!result.success) {
          consecutiveErrors++;
          const errorLimit = this.config.loopMode ? 8 : 3;
          if (!result.recoverable || consecutiveErrors >= errorLimit) {
            console.log("[AgentRunner] Too many errors, forcing finish");
            finished = true;
            this.emitUpdate({
              step: stepNum,
              totalSteps: this.config.maxSteps,
              action: {
                type: "finish",
                params: {
                  answer:
                    "I encountered repeated errors (likely due to page security restrictions). Here's what I observed: " +
                    JSON.stringify(
                      this.steps.map(
                        (s) =>
                          s.action.type +
                          ":" +
                          (s.result.success ? "ok" : "fail"),
                      ),
                    ),
                },
                reasoning: "Forced finish due to errors",
              },
              status: "success",
              sessionId: "",
            });
            break;
          }
        } else {
          consecutiveErrors = 0;
        }

        await this.sleep(this.config.targetPaceMs ?? 500);
      }

      if (!finished && !this.abortController.signal.aborted) {
        this.emitUpdate({
          step: this.config.maxSteps,
          totalSteps: this.config.maxSteps,
          action: {
            type: "finish",
            params: {
              answer: `Reached the step budget for this run after ${this.config.maxSteps} steps. I kept the task moving until the configured limit.`,
            },
            reasoning: "Step budget reached",
          },
          status: "success",
          sessionId: "",
        });
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
    void callback;
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

  private updateWorkingMemory(
    action: AgentAction,
    result: import("../types/AgentTypes").ActionResult,
  ): void {
    if (action.type === "finish") {
      const answer = (action.params as { answer?: string }).answer;
      if (answer) this.remember(`Final answer drafted: ${answer}`);
      return;
    }

    if (!result.success) {
      this.remember(`Failed ${action.type}: ${result.error}`);
      return;
    }

    if (action.type === "navigate") {
      const url = (action.params as { url?: string }).url;
      if (url) this.remember(`Navigated to ${url}`);
      return;
    }

    if (action.type === "extract") {
      this.remember(`Extracted ${this.compact(result.data, 260)}`);
      return;
    }

    if (
      action.type === "click" ||
      action.type === "type" ||
      action.type === "scroll" ||
      action.type === "key"
    ) {
      this.remember(
        `${action.type} succeeded: ${this.compact(action.params, 180)}`,
      );
    }
  }

  private remember(entry: string): void {
    const compactEntry = entry.replace(/\s+/g, " ").trim();
    if (!compactEntry) return;

    const lastEntry = this.workingMemory[this.workingMemory.length - 1];
    if (lastEntry === compactEntry) return;

    this.workingMemory.push(compactEntry);
    if (this.workingMemory.length > 12) {
      this.workingMemory = this.workingMemory.slice(-12);
    }
  }

  private buildWorkingMemory(): string {
    return this.workingMemory
      .map((entry, index) => `${index + 1}. ${entry}`)
      .join("\n");
  }

  private compact(value: unknown, maxLength: number): string {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return "";
    return text.length > maxLength
      ? `${text.substring(0, maxLength)}...`
      : text;
  }

  private getActionSignature(action: AgentAction): string {
    return `${action.type}:${this.compact(action.params, 120)}`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
