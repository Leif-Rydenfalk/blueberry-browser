import type { Window } from '../Window';
import { WorkflowRecorder } from './WorkflowRecorder';
import { WorkflowStore } from './WorkflowStore';
import type { Workflow, WorkflowStep, RecordingState } from './WorkflowTypes';

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

    this.recorder.setOnUpdate(state => this.onUpdate?.(state));
    this.recorder.setOnStepCaptured(step => this.onStepCaptured?.(step));

    // Hook into all existing tabs and any future ones
    this.recorder.hookAllTabs(window);
  }

  hookNewTab(tab: import('../Tab').Tab): void {
    this.recorder.hookTab(tab);
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
    const url = tab?.url ?? '';
    const title = tab?.title ?? '';
    this.recorder.addAnnotation(text, url, title);
    return true;
  }

  getRecordingState(): RecordingState {
    return this.recorder.getState();
  }

  getAllWorkflows() {
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

  buildAgentPrompt(workflowId: string, userGoalOverride?: string): string | null {
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
      if (step.data.type === 'navigation') {
        const p = step.data.payload;
        lines.push(`${stepNum}. [${new Date(step.timestamp).toLocaleTimeString()}] Navigated to: ${p.toUrl}`);
        if (p.pageTitle) lines.push(`   Page: "${p.pageTitle}"`);
        stepNum++;
      } else if (step.data.type === 'annotation') {
        lines.push(`   📝 User note: "${step.data.payload.text}"`);
      }
      // screenshots are omitted from prompt — they were captured for reference only
    }

    lines.push(`--- END OF RECORDING ---`);
    lines.push(``);

    if (userGoalOverride) {
      lines.push(`Current goal: ${userGoalOverride}`);
    } else {
      lines.push(`Goal: Reproduce this workflow exactly. Start at "${workflow.startUrl}", follow the same sequence of pages and actions. Use the user's notes as intent guidance. Adapt to the current state of each page as needed.`);
    }

    return lines.join('\n');
  }
}
