import type { Window } from "../../Window";
import type {
  AgentSessionRequest,
  AgentStreamUpdate,
  ApprovalDecision,
  ApprovalRequest,
  ScriptReviewRequest,
  ScriptReviewResolution,
} from "../types/AgentTypes";
import { AgentOrchestrator } from "./AgentOrchestrator";

export class AgentIpcHandler {
  readonly orchestrator: AgentOrchestrator;
  private updateListeners: Set<(update: AgentStreamUpdate) => void> = new Set();
  private approvalListeners: Set<(request: ApprovalRequest) => void> =
    new Set();
  private scriptReviewListeners: Set<(request: ScriptReviewRequest) => void> =
    new Set();

  constructor(window: Window) {
    this.orchestrator = new AgentOrchestrator(window);
    this.orchestrator.setStreamCallback((update) => {
      this.updateListeners.forEach((listener) => listener(update));
    });
    this.orchestrator.setApprovalCallback((request) => {
      this.approvalListeners.forEach((listener) => listener(request));
    });
    this.orchestrator.setScriptReviewCallback((request) => {
      this.scriptReviewListeners.forEach((listener) => listener(request));
    });
  }

  async start(
    request: AgentSessionRequest,
  ): Promise<{ sessionId: string; status: string }> {
    const session = await this.orchestrator.startSession(request);
    return { sessionId: session.id, status: session.status };
  }

  abort(): boolean {
    return this.orchestrator.abortSession();
  }

  sendMessage(message: string): boolean {
    return this.orchestrator.sendMessageToAgent(message);
  }

  getStatus(): { isRunning: boolean; activeSession: string | null } {
    return {
      isRunning: this.orchestrator.isRunning(),
      activeSession: this.orchestrator.getActiveSession()?.id || null,
    };
  }

  onUpdate(callback: (update: AgentStreamUpdate) => void): void {
    this.updateListeners.add(callback);
  }

  removeUpdateListener(callback: (update: AgentStreamUpdate) => void): void {
    this.updateListeners.delete(callback);
  }

  onApprovalRequired(callback: (request: ApprovalRequest) => void): void {
    this.approvalListeners.add(callback);
  }

  removeApprovalListener(callback: (request: ApprovalRequest) => void): void {
    this.approvalListeners.delete(callback);
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    return this.orchestrator.resolveApproval(id, decision);
  }

  getPendingApproval(): ApprovalRequest | null {
    return this.orchestrator.getPendingApproval();
  }

  onScriptReviewRequired(
    callback: (request: ScriptReviewRequest) => void,
  ): void {
    this.scriptReviewListeners.add(callback);
  }

  removeScriptReviewListener(
    callback: (request: ScriptReviewRequest) => void,
  ): void {
    this.scriptReviewListeners.delete(callback);
  }

  resolveScriptReview(id: string, resolution: ScriptReviewResolution): boolean {
    return this.orchestrator.resolveScriptReview(id, resolution);
  }

  getPendingScriptReview(): ScriptReviewRequest | null {
    return this.orchestrator.getPendingScriptReview();
  }
}
