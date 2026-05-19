import { v4 as uuidv4 } from "uuid";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentAction,
  AgentStep,
  AgentConfig,
  AgentStreamUpdate,
  ActionVerdict,
  ApprovalDecision,
  ApprovalRequest,
  ScriptReviewRequest,
  ScriptReviewResolution,
  CollectedBucketSummary,
  Subgoal,
  SubgoalStatus,
  TabStrategy,
  ExecuteScriptParams,
} from "../types/AgentTypes";
import {
  buildStaticSystemPrompt,
  buildDynamicPrompt,
} from "../prompts/systemPrompts";
import {
  classifyActionByText,
  classifyElementLabel,
  describeAction,
  type RiskAssessment,
} from "./ApprovalGate";

const SKIP_SCREENSHOT_ACTIONS = new Set([
  "extract",
  "extractSchema",
  "executeScript",
  "wait",
  "waitForSelector",
  "select",
  "finish",
  "screenshot",
  "waitForApproval",
]);

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (decision: ApprovalDecision) => void;
}

interface PendingScriptReview {
  readonly request: ScriptReviewRequest;
  readonly resolve: (resolution: ScriptReviewResolution) => void;
}

interface AgentTurnPayload {
  readonly action: AgentAction;
  readonly subgoal?: string;
  readonly progress?: string;
  readonly verifyLast?: ActionVerdict;
  readonly acceptanceCriteria?: string;
  readonly subgoals?: ReadonlyArray<Subgoal>;
}

// Accumulator state the runner maintains across turns. The model writes to
// it via JSON fields on each response; the runner echoes it back next turn
// inside the dynamic prompt. This is the substrate that gives the agent
// memory of "what I committed to" and "what I've collected".
interface RunState {
  acceptanceCriteria: string;
  subgoals: Subgoal[];
  progressNote: string;
  lastVerdict: ActionVerdict | null;
  lastSubgoal: string;
  collected: Map<string, CollectedBucket>;
  // Name of the most recent bucket the agent wrote rows into. Used as the
  // default "canonical" bucket when assembling the finish CSV — older
  // buckets are presumed superseded by newer ones (bucket versioning).
  lastExtractedBucket: string | null;
}

interface CollectedBucket {
  rows: Array<Record<string, unknown>>;
  rowKeys: Set<string>; // dedupe key per row
  fields: Set<string>;
}

const MAX_BUCKET_ROWS = 500;
const MAX_BUCKET_SAMPLE = 200;
const SUBGOAL_STATUSES: ReadonlySet<SubgoalStatus> = new Set([
  "pending",
  "in_progress",
  "done",
  "failed",
]);

// Source of truth for "is this a real action type" — used by the parser to
// skip JSON objects where the model put a self-tracking field name in "type"
// (e.g. {"type":"verifyLast",...}).
const KNOWN_ACTION_TYPES: ReadonlySet<string> = new Set([
  "navigate",
  "click",
  "type",
  "key",
  "scroll",
  "wait",
  "extract",
  "extractSchema",
  "executeScript",
  "screenshot",
  "finish",
  "select",
  "hover",
  "back",
  "forward",
  "newTab",
  "switchTab",
  "closeTab",
  "waitForSelector",
  "waitForApproval",
]);

// Scan text for all balanced top-level JSON objects, returning their raw
// substrings in source order. Handles strings/escapes correctly so braces
// inside string literals don't fool the depth counter.
function findJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          results.push(text.substring(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function csvEscape(value: string): string {
  if (value === "") return "";
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

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
  private runState: RunState = this.createEmptyRunState();
  private pendingApproval: PendingApproval | null = null;
  private pendingScriptReview: PendingScriptReview | null = null;
  private approveAllForRun = false;
  private onUpdate: ((update: AgentStreamUpdate) => void) | null = null;
  private onComplete: ((steps: AgentStep[]) => void) | null = null;
  private onError: ((error: string) => void) | null = null;
  private onApprovalRequired: ((request: ApprovalRequest) => void) | null =
    null;
  private onScriptReviewRequired:
    | ((request: ScriptReviewRequest) => void)
    | null = null;

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

  setApprovalCallback(
    onApprovalRequired: (request: ApprovalRequest) => void,
  ): void {
    this.onApprovalRequired = onApprovalRequired;
  }

  setScriptReviewCallback(
    onScriptReviewRequired: (request: ScriptReviewRequest) => void,
  ): void {
    this.onScriptReviewRequired = onScriptReviewRequired;
  }

  getPendingScriptReview(): ScriptReviewRequest | null {
    return this.pendingScriptReview?.request ?? null;
  }

  resolveScriptReview(id: string, resolution: ScriptReviewResolution): boolean {
    if (!this.pendingScriptReview || this.pendingScriptReview.request.id !== id) {
      return false;
    }
    const resolve = this.pendingScriptReview.resolve;
    this.pendingScriptReview = null;
    resolve(resolution);
    return true;
  }

  async run(goal: string): Promise<void> {
    if (this.isRunning) {
      throw new Error("Agent is already running");
    }

    this.isRunning = true;
    this.steps = [];
    this.workingMemory = [];
    this.runState = this.createEmptyRunState();
    this.approveAllForRun = false;
    this.pendingApproval = null;
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
          acceptanceCriteria: this.runState.acceptanceCriteria,
          subgoals: this.runState.subgoals,
          progressNote: this.runState.progressNote,
          lastVerdict: this.runState.lastVerdict,
          collectedSummary: this.summarizeCollected(),
          repeatedActionCount,
          repeatedActionSignature: previousActionSignature,
          stepNumber: stepNum,
        };

        const staticSystem = buildStaticSystemPrompt();
        const dynamicPrompt = buildDynamicPrompt(context);
        const responseText = await this.llmClient.generateText(
          dynamicPrompt,
          undefined,
          staticSystem,
        );

        if (!responseText) {
          throw new Error("Failed to get response from LLM");
        }

        let turn = this.parseTurnFromResponse(responseText);

        // If agent requests a screenshot, capture and re-ask with the image
        if (turn?.action.type === "screenshot") {
          this.emitTurnUpdate(stepNum, turn, "running");
          const screenshotData = await this.strategy.captureScreenshot();
          if (screenshotData) {
            const visionResponse = await this.llmClient.generateVisionText(
              dynamicPrompt,
              screenshotData,
              undefined,
              staticSystem,
            );
            if (visionResponse) {
              const nextTurn = this.parseTurnFromResponse(visionResponse);
              if (nextTurn) turn = nextTurn;
            }
          }
        }
        if (!turn) {
          console.error(
            "[AgentRunner] Failed to parse turn from:",
            responseText,
          );
          throw new Error("Failed to parse valid action from LLM response");
        }

        // For data-collection finishes, replace any model-written CSV with the
        // bucket's authoritative CSV BEFORE the action runs. The model's role
        // in the answer is narrative — the data comes from the dedup'd bucket.
        if (turn.action.type === "finish") {
          const enrichedAction = this.enrichFinishAction(turn.action);
          if (enrichedAction !== turn.action) {
            turn = { ...turn, action: enrichedAction };
          }
        }

        const action = turn.action;
        this.applyTurnSelfTracking(turn, stepNum);

        const actionSignature = this.getActionSignature(action);
        repeatedActionCount =
          actionSignature === previousActionSignature
            ? repeatedActionCount + 1
            : 1;
        previousActionSignature = actionSignature;

        if (repeatedActionCount >= 2) {
          this.remember(
            `Same action ${repeatedActionCount}x in a row — likely stuck. Switch approach (screenshot, alt selector, coords, scroll).`,
          );
        }

        this.emitTurnUpdate(stepNum, turn, "running");

        const gate = await this.maybeRequestApproval(action, stepNum);
        if (gate === "stop") {
          console.log("[AgentRunner] User stopped run at approval gate");
          finished = true;
          this.emitUpdate({
            step: stepNum,
            totalSteps: this.config.maxSteps,
            action: {
              type: "finish",
              params: {
                answer: "Stopped by user at the approval checkpoint.",
              },
              reasoning: "User stopped the run",
            },
            status: "success",
            sessionId: "",
          });
          break;
        }
        if (gate === "skip") {
          const skipResult = {
            success: true as const,
            data: { skipped: true, reason: "User skipped this action" },
          };
          this.remember(`Skipped ${action.type} (user veto)`);
          const skippedStep: AgentStep = {
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result: skipResult,
          };
          this.steps.push(skippedStep);
          this.emitUpdate({
            step: stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "success",
            result: skipResult,
            sessionId: "",
          });
          await this.sleep(this.config.targetPaceMs ?? 500);
          continue;
        }

        // Explicit waitForApproval action — the agent paused itself. The gate
        // above already collected the decision; record it as the action's
        // result and move on.
        if (action.type === "waitForApproval") {
          const approvedResult = {
            success: true as const,
            data: { approved: true, decision: gate },
          };
          this.remember(
            `Approval received (${gate}) for: ${
              (action.params as { reason?: string }).reason ?? "pending action"
            }`,
          );
          const approvedStep: AgentStep = {
            id: uuidv4(),
            timestamp: Date.now(),
            action,
            result: approvedResult,
          };
          this.steps.push(approvedStep);
          this.emitUpdate({
            step: stepNum,
            totalSteps: this.config.maxSteps,
            action,
            status: "success",
            result: approvedResult,
            sessionId: "",
          });
          await this.sleep(this.config.targetPaceMs ?? 500);
          continue;
        }

        // executeScript always goes through the mandatory script review gate.
        // The user may edit the script before approving; we run whatever they approved.
        if (action.type === "executeScript") {
          const scriptParams = action.params as ExecuteScriptParams;
          const resolution = await this.requestScriptReview(action, stepNum);
          if (resolution.decision === "reject") {
            const rejectResult = {
              success: false as const,
              error: "Script rejected by user",
              recoverable: true,
            };
            this.remember(`executeScript rejected by user — try a different approach`);
            const rejectedStep: AgentStep = {
              id: uuidv4(),
              timestamp: Date.now(),
              action,
              result: rejectResult,
            };
            this.steps.push(rejectedStep);
            this.emitTurnUpdate(stepNum, turn, "error", { result: rejectResult });
            await this.sleep(this.config.targetPaceMs ?? 500);
            continue;
          }
          // Run with the approved script (may be user-edited)
          const effectiveScript = resolution.approvedScript ?? scriptParams.script;
          const effectiveAction: AgentAction = {
            type: "executeScript",
            params: { ...scriptParams, script: effectiveScript } as ExecuteScriptParams,
            reasoning: action.reasoning,
          };
          const result = await this.strategy.executeAction(effectiveAction);
          this.updateWorkingMemory(effectiveAction, result);
          const step: AgentStep = {
            id: uuidv4(),
            timestamp: Date.now(),
            action: effectiveAction,
            result,
          };
          this.steps.push(step);
          this.emitTurnUpdate(stepNum, turn, result.success ? "success" : "error", {
            result,
          });
          if (!result.success) {
            consecutiveErrors++;
            if (!result.recoverable || consecutiveErrors >= 3) {
              finished = true;
              break;
            }
          } else {
            consecutiveErrors = 0;
          }
          await this.sleep(this.config.targetPaceMs ?? 500);
          continue;
        }

        const result = await this.strategy.executeAction(action);
        const afterScreenshot = SKIP_SCREENSHOT_ACTIONS.has(action.type)
          ? null
          : await this.strategy.captureScreenshot();
        this.recordCollectedFromResult(action, result);
        this.updateWorkingMemory(action, result);

        const step: AgentStep = {
          id: uuidv4(),
          timestamp: Date.now(),
          action,
          result,
          screenshot: afterScreenshot || undefined,
        };
        this.steps.push(step);

        this.emitTurnUpdate(
          stepNum,
          turn,
          result.success ? "success" : "error",
          {
            result,
            screenshot: afterScreenshot || context.screenshot || undefined,
          },
        );

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
    // Release any pending gates so the run actually unwinds.
    if (this.pendingApproval) {
      const resolve = this.pendingApproval.resolve;
      this.pendingApproval = null;
      resolve("stop");
    }
    if (this.pendingScriptReview) {
      const resolve = this.pendingScriptReview.resolve;
      this.pendingScriptReview = null;
      resolve({ decision: "reject" });
    }
  }

  getPendingApproval(): ApprovalRequest | null {
    return this.pendingApproval?.request ?? null;
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    if (!this.pendingApproval || this.pendingApproval.request.id !== id) {
      return false;
    }
    if (decision === "approve-all") {
      this.approveAllForRun = true;
    }
    const resolve = this.pendingApproval.resolve;
    this.pendingApproval = null;
    resolve(decision);
    return true;
  }

  // Returns the decision the loop should act on, or null when no gate fires.
  // - null: no approval needed, proceed normally
  // - "approve-once" / "approve-all": proceed, optionally lift gate for run
  // - "skip": loop should skip the action and continue
  // - "stop": loop should finish
  private async maybeRequestApproval(
    action: AgentAction,
    stepNum: number,
  ): Promise<ApprovalDecision | null> {
    if (this.approveAllForRun && action.type !== "waitForApproval") {
      // User already opted to approve everything for the rest of this run.
      return null;
    }

    const risk = await this.assessRisk(action);
    if (!risk.destructive) return null;

    const label = await this.resolveActionLabel(action);
    const screenshot = await this.strategy.captureScreenshot();
    const request: ApprovalRequest = {
      id: uuidv4(),
      sessionId: "",
      action,
      reason: this.buildApprovalReason(action, risk, label),
      matchedKeyword: risk.matchedKeyword,
      elementLabel: label ?? undefined,
      previewData:
        action.type === "waitForApproval"
          ? (action.params as { previewData?: Record<string, unknown> })
              .previewData
          : undefined,
      screenshot: screenshot ?? undefined,
      createdAt: Date.now(),
    };

    console.log(
      `[AgentRunner] Approval gate at step ${stepNum} (${action.type}, kw=${risk.matchedKeyword ?? "explicit"})`,
    );

    return new Promise<ApprovalDecision>((resolve) => {
      this.pendingApproval = { request, resolve };
      this.onApprovalRequired?.(request);
    });
  }

  private async requestScriptReview(
    action: AgentAction,
    stepNum: number,
  ): Promise<ScriptReviewResolution> {
    const params = action.params as ExecuteScriptParams;
    const screenshot = await this.strategy.captureScreenshot();
    const request: ScriptReviewRequest = {
      id: uuidv4(),
      sessionId: "",
      script: params.script,
      description: params.description,
      name: params.name,
      screenshot: screenshot ?? undefined,
      createdAt: Date.now(),
    };

    console.log(`[AgentRunner] Script review gate at step ${stepNum}`);

    return new Promise<ScriptReviewResolution>((resolve) => {
      this.pendingScriptReview = { request, resolve };
      this.onScriptReviewRequired?.(request);
    });
  }

  private async assessRisk(action: AgentAction): Promise<RiskAssessment> {
    // Fast path: explicit + cheap text-based signals.
    const textBased = classifyActionByText(action);
    if (textBased.destructive) return textBased;

    // Fallback: ask the strategy for the actual element label.
    if (this.strategy.getActionLabel) {
      try {
        const label = await this.strategy.getActionLabel(action);
        return classifyElementLabel(action, label);
      } catch (error) {
        console.error("[AgentRunner] getActionLabel failed:", error);
      }
    }
    return { destructive: false };
  }

  private async resolveActionLabel(
    action: AgentAction,
  ): Promise<string | null> {
    if (!this.strategy.getActionLabel) return null;
    try {
      return await this.strategy.getActionLabel(action);
    } catch {
      return null;
    }
  }

  private buildApprovalReason(
    action: AgentAction,
    risk: RiskAssessment,
    label: string | null,
  ): string {
    if (action.type === "waitForApproval") {
      const params = action.params as { reason?: string };
      return params.reason || "Agent paused for approval";
    }
    const summary = describeAction(action);
    if (risk.matchedKeyword) {
      const where =
        risk.source === "elementLabel"
          ? "target element"
          : risk.source === "reasoning"
            ? "agent reasoning"
            : "action params";
      const labelHint = label ? ` Target reads: "${label}"` : "";
      return `${summary} — flagged by keyword "${risk.matchedKeyword}" in ${where}.${labelHint}`;
    }
    return summary;
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

  private parseTurnFromResponse(text: string): AgentTurnPayload | null {
    // Strip markdown code fences in case the model wrapped its JSON despite
    // the prompt forbidding them.
    const cleaned = text
      .replace(/```(?:json|js|javascript)?\s*/gi, "")
      .replace(/```\s*/g, "");

    const candidates = findJsonObjects(cleaned);
    if (candidates.length === 0) {
      console.error("[AgentRunner] No JSON found in response");
      return null;
    }

    // Iterate from LAST to FIRST. When the model self-corrects mid-response
    // ("Wait, I need to redo..."), the corrected turn is the trailing JSON
    // and the earlier one was the abandoned attempt. Also rejects JSON
    // objects whose "type" is a self-tracking field name (e.g. verifyLast).
    for (let i = candidates.length - 1; i >= 0; i--) {
      const raw = candidates[i];
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof parsed.type !== "string") continue;
      if (typeof parsed.params !== "object" || parsed.params === null) continue;
      if (!KNOWN_ACTION_TYPES.has(parsed.type)) {
        console.warn(
          `[AgentRunner] Ignoring JSON with non-action type="${parsed.type}" — likely a self-tracking field misplaced as an action`,
        );
        continue;
      }

      const action: AgentAction = {
        type: parsed.type as AgentAction["type"],
        params: parsed.params as AgentAction["params"],
        reasoning:
          typeof parsed.reasoning === "string"
            ? parsed.reasoning
            : "No reasoning provided",
      };

      return {
        action,
        subgoal:
          typeof parsed.subgoal === "string" ? parsed.subgoal : undefined,
        progress:
          typeof parsed.progress === "string" ? parsed.progress : undefined,
        verifyLast: this.parseVerifyLast(parsed.verifyLast),
        acceptanceCriteria:
          typeof parsed.acceptanceCriteria === "string"
            ? parsed.acceptanceCriteria
            : undefined,
        subgoals: this.parseSubgoals(parsed.subgoals),
      };
    }

    console.error(
      `[AgentRunner] No valid action JSON in response (${candidates.length} object(s) scanned)`,
    );
    return null;
  }

  private parseVerifyLast(value: unknown): ActionVerdict | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.worked !== "boolean") return undefined;
    return {
      worked: raw.worked,
      note: typeof raw.note === "string" ? raw.note : "",
    };
  }

  private parseSubgoals(value: unknown): ReadonlyArray<Subgoal> | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: Subgoal[] = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.text !== "string" || raw.text.length === 0) continue;
      const status =
        typeof raw.status === "string" &&
        SUBGOAL_STATUSES.has(raw.status as SubgoalStatus)
          ? (raw.status as SubgoalStatus)
          : "pending";
      out.push({ text: raw.text.substring(0, 200), status });
    }
    return out.length > 0 ? out : undefined;
  }

  // Capture the model's self-reported state into the run state so it gets
  // echoed back next turn. Acceptance criteria is sticky — once set, only
  // explicit overrides change it (so the agent can't quietly walk away
  // from its own commitment).
  private applyTurnSelfTracking(turn: AgentTurnPayload, stepNum: number): void {
    if (turn.acceptanceCriteria && turn.acceptanceCriteria.trim().length > 0) {
      this.runState.acceptanceCriteria = turn.acceptanceCriteria.trim();
    }
    if (turn.subgoals && turn.subgoals.length > 0) {
      this.runState.subgoals = [...turn.subgoals];
    }
    if (turn.progress) {
      this.runState.progressNote = turn.progress;
    }
    if (turn.subgoal) {
      this.runState.lastSubgoal = turn.subgoal;
    }
    // Only register verifyLast after the first step has been taken — there
    // is nothing to verify on turn 1.
    if (turn.verifyLast && stepNum > 1) {
      this.runState.lastVerdict = turn.verifyLast;
    }
  }

  private emitTurnUpdate(
    stepNum: number,
    turn: AgentTurnPayload,
    status: AgentStreamUpdate["status"],
    extra?: {
      result?: AgentStreamUpdate["result"];
      screenshot?: string;
    },
  ): void {
    this.onUpdate?.({
      step: stepNum,
      totalSteps: this.config.maxSteps,
      action: turn.action,
      status,
      result: extra?.result,
      screenshot: extra?.screenshot,
      sessionId: "",
      subgoal: turn.subgoal,
      progress: turn.progress,
      verifyLast: turn.verifyLast,
      subgoals: this.runState.subgoals.length
        ? [...this.runState.subgoals]
        : undefined,
      acceptanceCriteria: this.runState.acceptanceCriteria || undefined,
    });
  }

  private emitUpdate(update: AgentStreamUpdate): void {
    this.onUpdate?.(update);
  }

  private createEmptyRunState(): RunState {
    return {
      acceptanceCriteria: "",
      subgoals: [],
      progressNote: "",
      lastVerdict: null,
      lastSubgoal: "",
      collected: new Map(),
      lastExtractedBucket: null,
    };
  }

  // Walk every extract / extractSchema result, accumulate rows into a bucket
  // keyed by the action's "name" param. Dedupe by stringified content so
  // multiple paginated extracts of the same list don't bloat the bucket.
  private recordCollectedFromResult(
    action: AgentAction,
    result: import("../types/AgentTypes").ActionResult,
  ): void {
    if (!result.success) return;
    const data = result.data as Record<string, unknown> | null;
    if (!data) return;

    if (action.type === "extractSchema") {
      const params = action.params as { name?: string };
      const name = params.name?.trim();
      if (!name) return;
      const rows = data[name];
      if (!Array.isArray(rows)) return;
      this.recordCollected(name, rows);
      this.runState.lastExtractedBucket = name;
      return;
    }

    if (action.type === "extract") {
      const params = action.params as { name?: string };
      const name = params.name?.trim();
      if (!name) return;
      const value = data[name];
      if (Array.isArray(value)) {
        this.recordCollected(name, value);
        this.runState.lastExtractedBucket = name;
      }
      // Non-array extract values stay in workingMemory only — they aren't
      // tabular and don't belong in a bucket.
    }
  }

  private recordCollected(name: string, rows: ReadonlyArray<unknown>): void {
    let bucket = this.runState.collected.get(name);
    if (!bucket) {
      bucket = { rows: [], rowKeys: new Set(), fields: new Set() };
      this.runState.collected.set(name, bucket);
    }
    for (const row of rows) {
      if (bucket.rows.length >= MAX_BUCKET_ROWS) break;
      const normalized = this.normalizeRow(row);
      if (!normalized) continue;
      const key = this.rowKey(normalized);
      if (bucket.rowKeys.has(key)) continue;
      bucket.rowKeys.add(key);
      bucket.rows.push(normalized);
      for (const field of Object.keys(normalized)) bucket.fields.add(field);
    }
  }

  private normalizeRow(row: unknown): Record<string, unknown> | null {
    if (row === null || row === undefined) return null;
    if (typeof row === "object" && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    // Wrap scalars so extract-list values still accumulate into a bucket.
    return { value: row };
  }

  private rowKey(row: Record<string, unknown>): string {
    try {
      const keys = Object.keys(row).sort();
      return keys
        .map((k) => `${k}=${String(row[k] ?? "")
          .trim()
          .toLowerCase()}`)
        .join("|");
    } catch {
      return JSON.stringify(row);
    }
  }

  private summarizeCollected(): ReadonlyArray<CollectedBucketSummary> {
    const summaries: CollectedBucketSummary[] = [];
    for (const [name, bucket] of this.runState.collected) {
      summaries.push({
        name,
        count: bucket.rows.length,
        sample: bucket.rows.slice(0, MAX_BUCKET_SAMPLE),
        fields: [...bucket.fields],
      });
    }
    return summaries;
  }

  // When finishing a data-collection task, exactly ONE bucket is canonical.
  // Selection order:
  //   1. action.params.bucket (model's explicit override)
  //   2. runState.lastExtractedBucket (most recent extract wins — supports
  //      re-extract-with-versioned-name recovery: stocks → stocks_v2 → v3,
  //      v3 alone gets emitted, older dirty versions are dropped)
  //   3. Last non-empty bucket in insertion order (fallback)
  // The model's narrative is preserved; any model-written CSV is stripped.
  private enrichFinishAction(action: AgentAction): AgentAction {
    if (this.runState.collected.size === 0) return action;

    const params = action.params as { answer?: string; bucket?: string };

    const canonicalName = this.pickCanonicalBucket(params.bucket);
    if (!canonicalName) return action;
    const canonical = this.runState.collected.get(canonicalName);
    if (!canonical || canonical.rows.length === 0) return action;

    const originalAnswer = params.answer ?? "";
    const narrative = originalAnswer
      .replace(/```csv[\s\S]*?```/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const csvSection = this.bucketToCsvSection(canonicalName, canonical);
    if (!csvSection) return action;

    const droppedBuckets = [...this.runState.collected.entries()]
      .filter(
        ([name, b]) => name !== canonicalName && b.rows.length > 0,
      )
      .map(([name, b]) => `${name} (${b.rows.length})`);
    const droppedNote =
      droppedBuckets.length > 0
        ? `\n\n*(Older buckets dropped from output: ${droppedBuckets.join(", ")}. To include a different bucket, set params.bucket on finish.)*`
        : "";

    const enrichedAnswer =
      [
        narrative ||
          `Collected ${canonical.rows.length} rows in bucket "${canonicalName}".`,
        csvSection,
      ]
        .join("\n\n")
        .trim() + droppedNote;

    return {
      type: action.type,
      params: { ...params, answer: enrichedAnswer },
      reasoning: action.reasoning,
    };
  }

  private pickCanonicalBucket(explicit: string | undefined): string | null {
    if (
      typeof explicit === "string" &&
      explicit.length > 0 &&
      this.runState.collected.has(explicit) &&
      (this.runState.collected.get(explicit)?.rows.length ?? 0) > 0
    ) {
      return explicit;
    }
    if (
      this.runState.lastExtractedBucket &&
      this.runState.collected.has(this.runState.lastExtractedBucket) &&
      (this.runState.collected.get(this.runState.lastExtractedBucket)?.rows
        .length ?? 0) > 0
    ) {
      return this.runState.lastExtractedBucket;
    }
    // Fallback: last non-empty bucket in insertion order.
    let fallback: string | null = null;
    for (const [name, bucket] of this.runState.collected) {
      if (bucket.rows.length > 0) fallback = name;
    }
    return fallback;
  }

  private bucketToCsvSection(name: string, bucket: CollectedBucket): string {
    if (bucket.rows.length === 0) return "";
    const fields = [...bucket.fields];
    if (fields.length === 0) return "";
    const header = fields.map(csvEscape).join(",");
    const lines = bucket.rows.map((row) =>
      fields
        .map((f) => csvEscape(stringifyCell(row[f])))
        .join(","),
    );
    return `${name} (${bucket.rows.length} rows):\n\`\`\`csv\n${header}\n${lines.join("\n")}\n\`\`\``;
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

    if (action.type === "extractSchema") {
      const params = action.params as { name?: string };
      const dataObj = result.data as Record<string, unknown> | null;
      const rows = params.name ? dataObj?.[params.name] : null;
      const lastCount = Array.isArray(rows) ? rows.length : 0;
      const bucketTotal = params.name
        ? this.runState.collected.get(params.name)?.rows.length
        : undefined;
      const totalNote =
        bucketTotal !== undefined && params.name
          ? ` (bucket "${params.name}" now ${bucketTotal} unique rows)`
          : "";
      this.remember(
        `Schema-extracted ${lastCount} rows this call${totalNote}.`,
      );
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
