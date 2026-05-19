import { v4 as uuidv4 } from "uuid";
import type { Window } from "../../Window";
import type {
  AgentConfig,
  AgentSession,
  AgentStep,
  AgentStreamUpdate,
  AgentSessionRequest,
  AgentTaskProfile,
  ApprovalDecision,
  ApprovalRequest,
  ScriptReviewRequest,
  ScriptReviewResolution,
} from "../types/AgentTypes";
import { SingleTabStrategy } from "../strategies/SingleTabStrategy";
import { McpAgentRunner } from "../mcp/McpAgentRunner";

export class AgentOrchestrator {
  private window: Window;
  private sessions: Map<string, AgentSession> = new Map();
  private activeRunner: McpAgentRunner | null = null;
  private activeSessionId: string | null = null;
  private onStreamUpdate: ((update: AgentStreamUpdate) => void) | null = null;
  private onApprovalRequired:
    | ((request: ApprovalRequest) => void)
    | null = null;
  private onScriptReviewRequired:
    | ((request: ScriptReviewRequest) => void)
    | null = null;

  constructor(window: Window) {
    this.window = window;
  }

  setStreamCallback(callback: (update: AgentStreamUpdate) => void): void {
    this.onStreamUpdate = callback;
  }

  setApprovalCallback(callback: (request: ApprovalRequest) => void): void {
    this.onApprovalRequired = callback;
  }

  setScriptReviewCallback(
    callback: (request: ScriptReviewRequest) => void,
  ): void {
    this.onScriptReviewRequired = callback;
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    return this.activeRunner?.resolveApproval(id, decision) ?? false;
  }

  getPendingApproval(): ApprovalRequest | null {
    return this.activeRunner?.getPendingApproval() ?? null;
  }

  resolveScriptReview(id: string, resolution: ScriptReviewResolution): boolean {
    return this.activeRunner?.resolveScriptReview(id, resolution) ?? false;
  }

  getPendingScriptReview(): ScriptReviewRequest | null {
    return this.activeRunner?.getPendingScriptReview() ?? null;
  }

  async startSession(request: AgentSessionRequest): Promise<AgentSession> {
    const sessionId = uuidv4();
    const profile = this.classifyTask(request.goal);
    const longRunning = profile === "repetitive" || profile === "communication";

    const config: AgentConfig = {
      maxSteps: this.getMaxSteps(profile, request.goal),
      model: "gpt-4o-mini",
      temperature: 0.7,
      strategy: request.mode,
      maxDurationMs: this.getMaxDurationMs(profile),
      loopMode:
        longRunning || this.hasAny(request.goal, ["while", "until", "repeat"]),
      taskProfile: profile,
      targetPaceMs: profile === "repetitive" ? 1200 : 700,
    };

    const session: AgentSession = {
      id: sessionId,
      goal: request.goal,
      status: "running",
      steps: [],
      currentStep: 0,
      maxSteps: config.maxSteps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;

    // Create LLM client
    const sidebar = this.window.sidebar;
    const llmClient = sidebar.client;

    // Create strategy (uses the LLM client for smart actions like extractSchema)
    const strategy = new SingleTabStrategy(this.window, llmClient);

    // Create runner
    const runner = new McpAgentRunner(config, strategy, llmClient);
    this.activeRunner = runner;

    runner.setApprovalCallback((request) => {
      this.onApprovalRequired?.({ ...request, sessionId });
    });
    runner.setScriptReviewCallback((request) => {
      this.onScriptReviewRequired?.({ ...request, sessionId });
    });

    // Set up callbacks
    runner.setCallbacks(
      (update) => {
        const enrichedUpdate = { ...update, sessionId };
        console.log(
          "[AgentOrchestrator] Emitting update:",
          enrichedUpdate.action.type,
          enrichedUpdate.status,
        );
        this.onStreamUpdate?.(enrichedUpdate);

        // Update session
        const sess = this.sessions.get(sessionId);
        if (sess) {
          sess.currentStep = update.step;
          sess.updatedAt = Date.now();
          if (update.status === "success" || update.status === "error") {
            const step: AgentStep = {
              id: uuidv4(),
              timestamp: Date.now(),
              action: update.action,
              result: update.result || { success: true, data: null },
              screenshot: update.screenshot,
            };
            sess.steps.push(step);
          }
        }
      },
      (steps) => {
        const sess = this.sessions.get(sessionId);
        if (sess) {
          sess.status = "completed";
          sess.steps = steps;
          sess.updatedAt = Date.now();
        }
        this.activeRunner = null;
      },
      (error) => {
        const sess = this.sessions.get(sessionId);
        if (sess) {
          sess.status = "error";
          sess.updatedAt = Date.now();
        }
        console.error(`[AgentOrchestrator] Session ${sessionId} error:`, error);
        this.onStreamUpdate?.({
          step: sess?.currentStep || 1,
          totalSteps: config.maxSteps,
          action: {
            type: "finish",
            params: { answer: error },
            reasoning: "Agent stopped with an error",
          },
          status: "error",
          result: { success: false, error, recoverable: true },
          sessionId,
        });
        this.activeRunner = null;
      },
    );

    // Start the agent loop
    runner.run(request.goal).catch((error) => {
      console.error("[AgentOrchestrator] Runner failed:", error);
      const sess = this.sessions.get(sessionId);
      if (sess) {
        sess.status = "error";
        sess.updatedAt = Date.now();
      }
      this.activeRunner = null;
    });

    return session;
  }

  abortSession(sessionId?: string): boolean {
    const targetId = sessionId || this.activeSessionId;
    if (!targetId) return false;

    const session = this.sessions.get(targetId);
    if (!session) return false;

    if (this.activeRunner && this.activeSessionId === targetId) {
      this.activeRunner.abort();
    }

    session.status = "paused";
    session.updatedAt = Date.now();
    return true;
  }

  sendMessageToAgent(message: string): boolean {
    if (!this.activeRunner || !this.isRunning()) return false;
    this.activeRunner.sendUserMessage(message);
    return true;
  }

  // Run a single goal end-to-end and resolve with the agent's final answer.
  // Used by bulk workflow execution where we need to await each row's result.
  async runOneShot(goal: string): Promise<{
    sessionId: string;
    status: AgentSession["status"];
    answer: string | null;
    steps: AgentStep[];
  }> {
    if (this.activeRunner) {
      throw new Error("Another agent run is already in progress");
    }

    const sessionId = uuidv4();
    const profile = this.classifyTask(goal);
    const longRunning = profile === "repetitive" || profile === "communication";

    const config: AgentConfig = {
      maxSteps: this.getMaxSteps(profile, goal),
      model: "gpt-4o-mini",
      temperature: 0.7,
      strategy: "single-tab",
      maxDurationMs: this.getMaxDurationMs(profile),
      loopMode: longRunning || this.hasAny(goal, ["while", "until", "repeat"]),
      taskProfile: profile,
      targetPaceMs: profile === "repetitive" ? 1200 : 700,
    };

    const session: AgentSession = {
      id: sessionId,
      goal,
      status: "running",
      steps: [],
      currentStep: 0,
      maxSteps: config.maxSteps,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;

    const llmClient = this.window.sidebar.client;
    const strategy = new SingleTabStrategy(this.window, llmClient);
    const runner = new McpAgentRunner(config, strategy, llmClient);
    this.activeRunner = runner;

    runner.setApprovalCallback((request) => {
      this.onApprovalRequired?.({ ...request, sessionId });
    });
    runner.setScriptReviewCallback((request) => {
      this.onScriptReviewRequired?.({ ...request, sessionId });
    });

    return new Promise((resolve) => {
      runner.setCallbacks(
        (update) => {
          const enriched = { ...update, sessionId };
          this.onStreamUpdate?.(enriched);
          const sess = this.sessions.get(sessionId);
          if (sess) {
            sess.currentStep = update.step;
            sess.updatedAt = Date.now();
            if (update.status === "success" || update.status === "error") {
              const step: AgentStep = {
                id: uuidv4(),
                timestamp: Date.now(),
                action: update.action,
                result: update.result || { success: true, data: null },
                screenshot: update.screenshot,
              };
              sess.steps.push(step);
            }
          }
        },
        (steps) => {
          const sess = this.sessions.get(sessionId);
          if (sess) {
            sess.status = "completed";
            sess.steps = steps;
            sess.updatedAt = Date.now();
          }
          this.activeRunner = null;
          const answer = this.extractFinishAnswer(steps);
          resolve({
            sessionId,
            status: "completed",
            answer,
            steps,
          });
        },
        (error) => {
          const sess = this.sessions.get(sessionId);
          if (sess) {
            sess.status = "error";
            sess.updatedAt = Date.now();
          }
          this.activeRunner = null;
          resolve({
            sessionId,
            status: "error",
            answer: error,
            steps: sess?.steps ?? [],
          });
        },
      );

      runner.run(goal).catch((error) => {
        console.error("[AgentOrchestrator] runOneShot failed:", error);
        const sess = this.sessions.get(sessionId);
        if (sess) {
          sess.status = "error";
          sess.updatedAt = Date.now();
        }
        this.activeRunner = null;
        resolve({
          sessionId,
          status: "error",
          answer: error instanceof Error ? error.message : String(error),
          steps: sess?.steps ?? [],
        });
      });
    });
  }

  private extractFinishAnswer(steps: ReadonlyArray<AgentStep>): string | null {
    for (let i = steps.length - 1; i >= 0; i--) {
      const step = steps[i];
      if (step.action.type === "finish") {
        const answer = (step.action.params as { answer?: string }).answer;
        return answer ?? null;
      }
    }
    return null;
  }

  getSession(sessionId: string): AgentSession | null {
    return this.sessions.get(sessionId) || null;
  }

  getActiveSession(): AgentSession | null {
    if (!this.activeSessionId) return null;
    return this.sessions.get(this.activeSessionId) || null;
  }

  getAllSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }

  isRunning(): boolean {
    return this.activeRunner?.isActive() ?? false;
  }

  private classifyTask(goal: string): AgentTaskProfile {
    if (
      this.hasAny(goal, [
        "scroll",
        "like",
        "linkedin feed",
        "tiktok",
        "instagram",
        "for a while",
        "repetitive",
        "repeat",
      ])
    ) {
      return "repetitive";
    }

    if (
      this.hasAny(goal, [
        "inbox",
        "email",
        "mail",
        "gmail",
        "outlook",
        "reply",
        "respond",
        "message",
        "dm",
      ])
    ) {
      return "communication";
    }

    // Data-collection tasks (gather N stocks, build a spreadsheet, scrape a list,
    // extract a table) are research-grade — they need multiple paginations and
    // verifications, not a 20-step quick budget.
    if (this.isDataCollectionGoal(goal)) {
      return "research";
    }

    if (
      this.hasAny(goal, ["find", "research", "compare", "look up", "browse"])
    ) {
      return "research";
    }

    return "quick";
  }

  private isDataCollectionGoal(goal: string): boolean {
    return this.hasAny(goal, [
      "spreadsheet",
      "csv",
      "table",
      "gather",
      "collect",
      "scrape",
      "extract",
      "list of",
      "compile",
      "rows",
      "dataset",
      "tabulate",
    ]);
  }

  private getMaxSteps(profile: AgentTaskProfile, goal: string): number {
    // Match "N X" where X is any plural-ish noun the user might pick when
    // asking for a count. Broader than the old hardcoded list — "50 pieces
    // of stock data" or "100 products" both land here.
    const explicitCount =
      goal.match(
        /\b(\d{1,4})\s+(videos?|posts?|emails?|messages?|items?|times?|likes?|replies?|rows?|stocks?|products?|results?|entries?|records?|pieces?|tickers?|companies|companys?|articles?|users?|profiles?|listings?|coins?|tokens?|reviews?|comments?|tweets?)\b/i,
      ) ||
      // Fallback: numeric count + data-collection verb in same goal.
      (this.isDataCollectionGoal(goal)
        ? goal.match(/\b(\d{1,4})\b/)
        : null);
    if (explicitCount) {
      const requested = Number(explicitCount[1]);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.max(requested * 6, 40), 500);
      }
    }

    switch (profile) {
      case "repetitive":
        return 300;
      case "communication":
        return 180;
      case "research":
        return 60;
      case "quick":
      default:
        return 20;
    }
  }

  private getMaxDurationMs(profile: AgentTaskProfile): number {
    switch (profile) {
      case "repetitive":
        return 60 * 60 * 1000;
      case "communication":
        return 45 * 60 * 1000;
      case "research":
        return 20 * 60 * 1000;
      case "quick":
      default:
        return 10 * 60 * 1000;
    }
  }

  private hasAny(text: string, needles: readonly string[]): boolean {
    const lower = text.toLowerCase();
    return needles.some((needle) => lower.includes(needle));
  }
}
