import { v4 as uuidv4 } from "uuid";
import type { Window } from "../../Window";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentConfig,
  AgentSession,
  AgentStep,
  AgentStreamUpdate,
  AgentSessionRequest,
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

    const config: AgentConfig = {
      maxSteps: request.goal.toLowerCase().includes('scroll') || request.goal.toLowerCase().includes('like') ? 50 : 15,
      model: "gpt-4o-mini",
      temperature: 0.7,
      strategy: request.mode,
      maxDurationMs: 10 * 60 * 1000, // 10 minutes max
      loopMode: request.goal.toLowerCase().includes('scroll') || request.goal.toLowerCase().includes('while'),
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

    // Create strategy
    const strategy = new SingleTabStrategy(this.window);

    // Create LLM client
    const sidebar = this.window.sidebar;
    const llmClient = sidebar.client;

    // Create runner
    const runner = new AgentRunner(config, strategy, llmClient);
    this.activeRunner = runner;

    // Set up callbacks
    runner.setCallbacks(
      (update) => {
        const enrichedUpdate = { ...update, sessionId };
        console.log("[AgentOrchestrator] Emitting update:", enrichedUpdate.action.type, enrichedUpdate.status);
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
        this.activeRunner = null;
      }
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
}
