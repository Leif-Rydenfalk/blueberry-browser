import { v4 as uuidv4 } from "uuid";
import type { Window } from "../../Window";
import type {
  AgentConfig,
  AgentSession,
  AgentStep,
  AgentStreamUpdate,
  AgentSessionRequest,
  AgentTaskProfile,
} from "../types/AgentTypes";
import { SingleTabStrategy } from "../strategies/SingleTabStrategy";
import { AgentRunner } from "./AgentRunner";

export class AgentOrchestrator {
  private window: Window;
  private sessions: Map<string, AgentSession> = new Map();
  private activeRunner: AgentRunner | null = null;
  private activeSessionId: string | null = null;
  private onStreamUpdate: ((update: AgentStreamUpdate) => void) | null = null;

  constructor(window: Window) {
    this.window = window;
  }

  setStreamCallback(callback: (update: AgentStreamUpdate) => void): void {
    this.onStreamUpdate = callback;
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
    const runner = new AgentRunner(config, strategy, llmClient);
    this.activeRunner = runner;

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

    if (
      this.hasAny(goal, ["find", "research", "compare", "look up", "browse"])
    ) {
      return "research";
    }

    return "quick";
  }

  private getMaxSteps(profile: AgentTaskProfile, goal: string): number {
    const explicitCount = goal.match(
      /\b(\d{1,3})\s+(videos?|posts?|emails?|messages?|items?|times?|likes?|replies?)\b/i,
    );
    if (explicitCount) {
      const requested = Number(explicitCount[1]);
      if (Number.isFinite(requested) && requested > 0) {
        return Math.min(Math.max(requested * 6, 30), 500);
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
