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
  CollectedBucketSummary,
  ApprovalRequest,
  LoginDecision,
  LoginRequiredRequest,
  PromptAttachment,
  ScriptReviewRequest,
  ScriptReviewResolution,
  WorkflowResult,
  WorkflowStep,
  WorkflowStepResult,
} from "../types/AgentTypes";
import { SingleTabStrategy } from "../strategies/SingleTabStrategy";
import { McpAgentRunner, type BucketStore } from "../mcp/McpAgentRunner";

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
  private onLoginRequired:
    | ((request: LoginRequiredRequest) => void)
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

  setLoginCallback(callback: (request: LoginRequiredRequest) => void): void {
    this.onLoginRequired = callback;
  }

  resolveLogin(id: string, decision: LoginDecision): boolean {
    return this.activeRunner?.resolveLogin(id, decision) ?? false;
  }

  getPendingLogin(): LoginRequiredRequest | null {
    return this.activeRunner?.getPendingLogin() ?? null;
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
    const goal = this.enrichGoalWithAttachments(request.goal, request.attachments);
    const profile = this.classifyTask(goal);
    const longRunning = profile === "repetitive" || profile === "communication";
    const prefs = this.window.sidebar.settings.getAgentPreferences();

    const config: AgentConfig = {
      maxSteps: this.getMaxSteps(profile, goal),
      model: "gpt-4o-mini",
      temperature: 0.7,
      strategy: request.mode,
      maxDurationMs: this.getMaxDurationMs(profile),
      loopMode:
        longRunning || this.hasAny(goal, ["while", "until", "repeat"]),
      taskProfile: profile,
      targetPaceMs: profile === "repetitive" ? 1200 : 700,
      alwaysAllowScripts: prefs.alwaysAllowScripts || prefs.autoApprove,
      autoApprove: prefs.autoApprove,
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
    runner.setLoginCallback((request) => {
      this.onLoginRequired?.({ ...request, sessionId });
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
    runner.run(goal, request.conversationHistory).catch((error) => {
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

  // Inject a steering message into the running agent. The message surfaces in
  // the agent's next tool result so it can adjust direction without the run
  // being interrupted or restarted. Returns true if an active runner received it.
  steerAgent(message: string): boolean {
    if (!this.activeRunner) return false;
    this.activeRunner.addSteerMessage(message);
    return true;
  }

  // Run a single goal end-to-end and resolve with the agent's final answer.
  // Used by bulk workflow execution and MCP delegation.
  // Workflows pass a shared bucketStore so extracted rows survive between steps.
  // onStepUpdate fires for each agent step — MCP handler uses this to stream
  // progress events to SSE subscribers.
  async runOneShot(
    goal: string,
    sharedBucketStore?: BucketStore,
    onStepUpdate?: (update: AgentStreamUpdate) => void,
  ): Promise<{
    sessionId: string;
    status: AgentSession["status"];
    answer: string | null;
    steps: AgentStep[];
    bucketSummaries: ReadonlyArray<CollectedBucketSummary>;
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
      alwaysAllowScripts: true,
      autoApprove: true,
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
    const runner = new McpAgentRunner(
      config,
      strategy,
      llmClient,
      sharedBucketStore,
    );
    this.activeRunner = runner;

    runner.setApprovalCallback((request) => {
      this.onApprovalRequired?.({ ...request, sessionId });
    });
    runner.setScriptReviewCallback((request) => {
      this.onScriptReviewRequired?.({ ...request, sessionId });
    });
    runner.setLoginCallback((request) => {
      this.onLoginRequired?.({ ...request, sessionId });
    });

    return new Promise((resolve) => {
      let settled = false;

      // Resolve exactly once — prevents double-resolve from timeout + normal completion
      const resolveOnce = (result: {
        sessionId: string;
        status: AgentSession["status"];
        answer: string | null;
        steps: AgentStep[];
        bucketSummaries: ReadonlyArray<CollectedBucketSummary>;
      }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        this.activeRunner = null;
        resolve(result);
      };

      // Enforce maxDurationMs — abort the runner when the wall-clock budget is
      // exhausted so the MCP caller always gets a response.
      const timeoutMs = config.maxDurationMs ?? 10 * 60 * 1000;
      const timeoutHandle = setTimeout(() => {
        console.error(
          `[AgentOrchestrator] runOneShot timed out after ${timeoutMs}ms — aborting runner`,
        );
        runner.abort();
        const sess = this.sessions.get(sessionId);
        if (sess) {
          sess.status = "error";
          sess.updatedAt = Date.now();
        }
        resolveOnce({
          sessionId,
          status: "error",
          answer: `Agent run timed out after ${Math.round(timeoutMs / 1000)}s`,
          steps: sess?.steps ?? [],
          bucketSummaries: runner.getSummaryOfCollected(),
        });
      }, timeoutMs);

      runner.setCallbacks(
        (update) => {
          const enriched = { ...update, sessionId };
          this.onStreamUpdate?.(enriched);
          onStepUpdate?.(enriched);
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
          const answer = this.extractFinishAnswer(steps);
          resolveOnce({
            sessionId,
            status: "completed",
            answer,
            steps,
            bucketSummaries: runner.getSummaryOfCollected(),
          });
        },
        (error) => {
          const sess = this.sessions.get(sessionId);
          if (sess) {
            sess.status = "error";
            sess.updatedAt = Date.now();
          }
          resolveOnce({
            sessionId,
            status: "error",
            answer: error,
            steps: sess?.steps ?? [],
            bucketSummaries: runner.getSummaryOfCollected(),
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
        resolveOnce({
          sessionId,
          status: "error",
          answer: error instanceof Error ? error.message : String(error),
          steps: sess?.steps ?? [],
          bucketSummaries: runner.getSummaryOfCollected(),
        });
      });
    });
  }

  // Run a structured multi-step workflow. Each step is a runOneShot call;
  // answers from completed steps are injected as context into subsequent steps.
  // onStepUpdate, when provided, is forwarded to every runOneShot call so the
  // MCP handler can stream per-step progress across all workflow steps.
  async runWorkflow(
    steps: ReadonlyArray<WorkflowStep>,
    sharedContext?: string,
    onStepUpdate?: (update: AgentStreamUpdate) => void,
  ): Promise<WorkflowResult> {
    const workflowId = uuidv4();
    const stepResults: WorkflowStepResult[] = [];

    // Shared bucket store: extracted rows from step N remain available to step N+1.
    // The agent in later steps sees the inventory in its initial prompt and can
    // opt to reference any of these in finish(includeBuckets:[...]).
    const sharedBuckets: BucketStore = new Map();

    for (const step of steps) {
      const contextBlock = this.buildWorkflowContext(step, stepResults, sharedContext);
      const fullTask = contextBlock ? `${step.task}\n\n${contextBlock}` : step.task;

      try {
        const runResult = await this.runOneShot(fullTask, sharedBuckets, onStepUpdate);
        const stepStatus: WorkflowStepResult["status"] =
          runResult.status === "completed"
            ? "completed"
            : runResult.status === "paused"
              ? "aborted"
              : "error";
        stepResults.push({
          name: step.name,
          status: stepStatus,
          answer: runResult.answer,
          stepCount: runResult.steps.length,
          bucketSummaries: runResult.bucketSummaries,
          error: stepStatus !== "completed" ? (runResult.answer ?? "Step failed") : undefined,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[AgentOrchestrator] Workflow step "${step.name}" failed:`, message);
        stepResults.push({
          name: step.name,
          status: "error",
          answer: null,
          stepCount: 0,
          error: message,
        });
        // Continue remaining steps — later steps can synthesize partial data
      }
    }

    const allCompleted = stepResults.every((r) => r.status === "completed");
    const anyCompleted = stepResults.some((r) => r.status === "completed");
    const status: WorkflowResult["status"] = allCompleted
      ? "completed"
      : anyCompleted
        ? "partial"
        : "error";

    // Last completed step's answer is the primary output
    const finalAnswer =
      [...stepResults].reverse().find((r) => r.answer !== null)?.answer ?? null;

    return {
      workflowId,
      status,
      steps: stepResults,
      finalAnswer,
      totalStepCount: stepResults.reduce((sum, r) => sum + r.stepCount, 0),
    };
  }

  private buildWorkflowContext(
    step: WorkflowStep,
    completed: ReadonlyArray<WorkflowStepResult>,
    sharedContext?: string,
  ): string {
    if (completed.length === 0 && !sharedContext) return "";

    const parts: string[] = [];

    if (sharedContext) {
      parts.push(`Background context:\n${sharedContext}`);
    }

    const deps = step.dependsOn ?? completed.map((s) => s.name);
    const relevant = completed.filter((s) => deps.includes(s.name) && s.answer !== null);

    if (relevant.length > 0) {
      parts.push(
        "Results from previous steps:\n" +
          relevant.map((r) => `--- ${r.name} ---\n${r.answer}`).join("\n\n"),
      );
    }

    return parts.join("\n\n");
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

    // Multi-app pipeline: explicit step numbering or combining 2+ distinct services
    if (this.isPipelineGoal(goal)) {
      return "pipeline";
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

  private isPipelineGoal(goal: string): boolean {
    // Explicit sequential-step language
    const hasStepNumbers = /step\s*[123]|first[,\s].*then[,\s].*finally/i.test(goal);

    // Two or more distinct web apps mentioned together
    const appMentions = [
      "gmail", "google calendar", "google sheets", "google drive",
      "slack", "notion", "salesforce", "linkedin", "hubspot",
      "airtable", "jira", "github", "trello",
    ].filter((app) => goal.toLowerCase().includes(app));

    return hasStepNumbers || appMentions.length >= 2;
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
      case "pipeline":
        return 120;
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
      case "pipeline":
        return 45 * 60 * 1000;
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

  private enrichGoalWithAttachments(
    goal: string,
    attachments?: ReadonlyArray<PromptAttachment>,
  ): string {
    if (!attachments || attachments.length === 0) return goal;
    const parts: string[] = [goal, ""];
    const urls = attachments.filter((a) => a.type === "url" && a.url);
    const files = attachments.filter((a) => a.type === "file");
    if (urls.length > 0) {
      parts.push(
        "Attached URLs (navigate to these as part of the task):\n" +
          urls.map((a) => `- ${a.name}: ${a.url}`).join("\n"),
      );
    }
    if (files.length > 0) {
      parts.push(
        "Attached files (use this content as context):\n" +
          files
            .map((a) => `--- ${a.name} ---\n${a.content ?? "(no content)"}`)
            .join("\n\n"),
      );
    }
    return parts.join("\n");
  }
}
