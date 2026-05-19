import type { Window } from "../Window";
import { WorkflowRecorder } from "./WorkflowRecorder";
import { WorkflowStore } from "./WorkflowStore";
import {
  WORKFLOW_CHANNELS,
  type Workflow,
  type WorkflowStep,
  type RecordingState,
  type DomEventPayload,
} from "./WorkflowTypes";

export class WorkflowIpcHandler {
  private readonly recorder: WorkflowRecorder;
  private readonly store: WorkflowStore;
  private readonly window: Window;
  private onUpdate: ((state: RecordingState) => void) | null = null;
  private onStepCaptured: ((step: WorkflowStep) => void) | null = null;

  constructor(window: Window) {
    this.window = window;
    this.recorder = new WorkflowRecorder();
    this.store = new WorkflowStore();

    this.recorder.setOnUpdate((state) => {
      this.onUpdate?.(state);
      this.broadcastRecordingActive(state.isRecording);
    });
    this.recorder.setOnStepCaptured((step) => this.onStepCaptured?.(step));

    // Hook into all existing tabs and any future ones
    this.recorder.hookAllTabs(window);
  }

  hookNewTab(tab: import("../Tab").Tab): void {
    this.recorder.hookTab(tab);
    // Bring the new tab up to date with the current recording state so its
    // tabRecorder preload starts emitting immediately after load.
    if (this.recorder.isRecording) {
      tab.webContents.send(WORKFLOW_CHANNELS.RECORDING_ACTIVE_CHANGED, true);
    }
  }

  handleDomEvent(payload: DomEventPayload): void {
    this.recorder.captureInteraction(payload);
  }

  private broadcastRecordingActive(active: boolean): void {
    for (const tab of this.window.allTabs) {
      try {
        tab.webContents.send(
          WORKFLOW_CHANNELS.RECORDING_ACTIVE_CHANGED,
          active,
        );
      } catch (error) {
        console.error(
          "[WorkflowIpcHandler] Failed to broadcast recording state:",
          error,
        );
      }
    }
  }

  setOnUpdate(cb: (state: RecordingState) => void): void {
    this.onUpdate = cb;
  }

  setOnStepCaptured(cb: (step: WorkflowStep) => void): void {
    this.onStepCaptured = cb;
  }

  startRecording(): RecordingState {
    this.recorder.start();
    return this.recorder.getState();
  }

  async stopRecording(name: string): Promise<Workflow | null> {
    const workflow = this.recorder.stop(name);
    if (workflow) {
      this.store.save(workflow);
    }
    return workflow;
  }

  cancelRecording(): void {
    this.recorder.cancel();
  }

  addAnnotation(text: string): boolean {
    if (!this.recorder.isRecording) return false;
    const tab = this.window.activeTab;
    const url = tab?.url ?? "";
    const title = tab?.title ?? "";
    this.recorder.addAnnotation(text, url, title);
    return true;
  }

  getRecordingState(): RecordingState {
    return this.recorder.getState();
  }

  getAllWorkflows(): import("./WorkflowTypes").WorkflowSummary[] {
    return this.store.listSummaries();
  }

  getWorkflow(id: string): Workflow | null {
    return this.store.load(id);
  }

  deleteWorkflow(id: string): boolean {
    return this.store.delete(id);
  }

  renameWorkflow(id: string, name: string): boolean {
    return this.store.rename(id, name);
  }

  buildAgentPrompt(
    workflowId: string,
    userGoalOverride?: string,
  ): string | null {
    const workflow = this.store.load(workflowId);
    if (!workflow) return null;

    const lines: string[] = [
      `You are reproducing a workflow that was previously recorded by a user.`,
      ``,
      `Workflow: "${workflow.name}"`,
      `Originally performed: ${new Date(workflow.createdAt).toLocaleString()}`,
      `Duration: ${Math.round(workflow.duration / 1000)}s`,
      ``,
      `--- RECORDED STEPS ---`,
    ];

    let stepNum = 1;
    for (const step of workflow.steps) {
      const time = new Date(step.timestamp).toLocaleTimeString();
      if (step.data.type === "navigation") {
        const p = step.data.payload;
        lines.push(`${stepNum}. [${time}] Navigated to: ${p.toUrl}`);
        if (p.pageTitle) lines.push(`   Page: "${p.pageTitle}"`);
        stepNum++;
      } else if (step.data.type === "interaction") {
        const p = step.data.payload;
        const labelPart = p.label ? ` "${p.label}"` : "";
        const selectorHint = `   selector: ${p.selector}   xpath: ${p.xpath}`;
        switch (p.eventType) {
          case "click":
            lines.push(
              `${stepNum}. [${time}] Click ${p.tag}${labelPart}${p.x !== undefined && p.y !== undefined ? ` at (${p.x},${p.y})` : ""}`,
            );
            lines.push(selectorHint);
            stepNum++;
            break;
          case "input":
          case "change": {
            const value = p.value ?? "";
            lines.push(
              `${stepNum}. [${time}] Type ${JSON.stringify(value)} into ${p.tag}${labelPart}`,
            );
            lines.push(selectorHint);
            stepNum++;
            break;
          }
          case "submit":
            lines.push(`${stepNum}. [${time}] Submit form${labelPart}`);
            lines.push(selectorHint);
            stepNum++;
            break;
          case "keydown":
            lines.push(
              `${stepNum}. [${time}] Press ${p.key || "key"}${labelPart ? ` in${labelPart}` : ""}`,
            );
            stepNum++;
            break;
        }
      } else if (step.data.type === "annotation") {
        lines.push(`   📝 User note: "${step.data.payload.text}"`);
      }
      // screenshots are omitted from prompt — they were captured for reference only
    }

    lines.push(`--- END OF RECORDING ---`);
    lines.push(``);

    if (userGoalOverride) {
      lines.push(`Current goal: ${userGoalOverride}`);
    } else {
      lines.push(
        `Goal: Reproduce this workflow exactly. Start at "${workflow.startUrl}", follow the recorded steps in order. For each "Click" / "Type" / "Submit" step, use the exact selector shown — if the click action returns "Element not found", consult the interactive elements list and find the closest semantic match (same label or role), then continue. Treat the user's notes as intent guidance.`,
      );
    }

    return lines.join("\n");
  }
}
