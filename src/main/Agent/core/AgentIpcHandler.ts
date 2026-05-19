import type { Window } from "../../Window";
import type {
  AgentSessionRequest,
  AgentStreamUpdate,
} from "../types/AgentTypes";
import { AgentOrchestrator } from "./AgentOrchestrator";

export class AgentIpcHandler {
  readonly orchestrator: AgentOrchestrator;
  private updateListeners: Set<(update: AgentStreamUpdate) => void> = new Set();

  constructor(window: Window) {
    this.orchestrator = new AgentOrchestrator(window);
    this.orchestrator.setStreamCallback((update) => {
      this.updateListeners.forEach((listener) => listener(update));
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
}
