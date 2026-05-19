import { v4 as uuidv4 } from "uuid";
import type { Window } from "../Window";
import type { AgentOrchestrator } from "../Agent/core/AgentOrchestrator";
import { WorkflowRecorder } from "./WorkflowRecorder";
import { WorkflowStore } from "./WorkflowStore";
import {
  WORKFLOW_CHANNELS,
  type Workflow,
  type WorkflowStep,
  type RecordingState,
  type DomEventPayload,
  type WorkflowDataset,
  type BulkRunProgress,
  type BulkRunResult,
} from "./WorkflowTypes";

export class WorkflowIpcHandler {
  private readonly recorder: WorkflowRecorder;
  private readonly store: WorkflowStore;
  private readonly window: Window;
  private orchestrator: AgentOrchestrator | null = null;
  private onUpdate: ((state: RecordingState) => void) | null = null;
  private onStepCaptured: ((step: WorkflowStep) => void) | null = null;
  private onBulkProgress: ((progress: BulkRunProgress) => void) | null = null;
  private onBulkComplete: ((result: BulkRunResult) => void) | null = null;
  private bulkAborted = false;

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

  setOnBulkProgress(cb: (progress: BulkRunProgress) => void): void {
    this.onBulkProgress = cb;
  }

  setOnBulkComplete(cb: (result: BulkRunResult) => void): void {
    this.onBulkComplete = cb;
  }

  setOrchestrator(orchestrator: AgentOrchestrator): void {
    this.orchestrator = orchestrator;
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

  // Parse a CSV string into { columns, rows }. Minimal RFC-4180 support:
  // quoted fields, escaped quotes (""), and newlines inside quotes.
  parseCsv(text: string, source?: string): WorkflowDataset {
    const rows: string[][] = [];
    let current: string[] = [];
    let field = "";
    let inQuotes = false;

    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    for (let i = 0; i < normalized.length; i++) {
      const ch = normalized[i];
      if (inQuotes) {
        if (ch === '"') {
          if (normalized[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        inQuotes = true;
        continue;
      }
      if (ch === ",") {
        current.push(field);
        field = "";
        continue;
      }
      if (ch === "\n") {
        current.push(field);
        rows.push(current);
        current = [];
        field = "";
        continue;
      }
      field += ch;
    }
    // flush last
    if (field.length > 0 || current.length > 0) {
      current.push(field);
      rows.push(current);
    }

    if (rows.length === 0) return { columns: [], rows: [], source };
    const header = rows[0].map((c) => c.trim()).filter((c) => c.length > 0);
    const data: Record<string, string>[] = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      // Skip fully-empty trailing rows
      if (row.every((v) => v.trim() === "")) continue;
      const obj: Record<string, string> = {};
      header.forEach((col, idx) => {
        obj[col] = (row[idx] ?? "").trim();
      });
      data.push(obj);
    }
    return { columns: header, rows: data, source };
  }

  attachDataset(id: string, dataset: WorkflowDataset): boolean {
    return this.store.setDataset(id, dataset);
  }

  clearDataset(id: string): boolean {
    return this.store.clearDataset(id);
  }

  setRecordingDataset(dataset: WorkflowDataset | null): void {
    this.recorder.setActiveDataset(dataset);
  }

  bindStepToColumn(id: string, stepId: string, column: string | null): boolean {
    return this.store.bindStepToColumn(id, stepId, column);
  }

  async executeBulk(
    workflowId: string,
    options?: { readonly goalOverride?: string },
  ): Promise<{ readonly runId: string } | { readonly error: string }> {
    if (!this.orchestrator) {
      return { error: "AgentOrchestrator not wired" };
    }
    const workflow = this.store.load(workflowId);
    if (!workflow) return { error: "Workflow not found" };
    const dataset = workflow.dataset;
    if (!dataset || dataset.rows.length === 0) {
      return { error: "No dataset attached to this workflow" };
    }

    const runId = `${Date.now()}-${uuidv4().substring(0, 8)}`;
    this.bulkAborted = false;
    void this.runBulkLoop(workflow, dataset, runId, options?.goalOverride);
    return { runId };
  }

  abortBulk(): void {
    this.bulkAborted = true;
  }

  private async runBulkLoop(
    workflow: Workflow,
    dataset: WorkflowDataset,
    runId: string,
    goalOverride: string | undefined,
  ): Promise<void> {
    let successes = 0;
    let failures = 0;
    let csvPath = "";

    for (let i = 0; i < dataset.rows.length; i++) {
      if (this.bulkAborted) break;
      const row = dataset.rows[i];

      this.emitBulkProgress({
        workflowId: workflow.id,
        runId,
        rowIndex: i,
        totalRows: dataset.rows.length,
        status: "running",
        currentRow: row,
      });

      const prompt = this.buildPromptForRow(workflow, row, goalOverride);
      let answer: string | null = null;
      let errorMsg: string | undefined;
      try {
        const result = await this.orchestrator!.runOneShot(prompt);
        answer = result.answer;
        if (result.status === "error") {
          errorMsg = result.answer || "Agent run errored";
        }
      } catch (error) {
        errorMsg = error instanceof Error ? error.message : String(error);
      }

      if (errorMsg) {
        failures++;
      } else {
        successes++;
      }

      csvPath = this.store.appendRunOutput(
        workflow.id,
        runId,
        dataset.columns,
        row,
        answer ?? "",
        errorMsg,
      );

      this.emitBulkProgress({
        workflowId: workflow.id,
        runId,
        rowIndex: i,
        totalRows: dataset.rows.length,
        status: errorMsg ? "error" : "completed",
        currentRow: row,
        answer: answer ?? undefined,
        error: errorMsg,
      });
    }

    const result: BulkRunResult = {
      workflowId: workflow.id,
      runId,
      totalRows: dataset.rows.length,
      successes,
      failures,
      csvPath,
    };
    this.onBulkComplete?.(result);
  }

  private emitBulkProgress(progress: BulkRunProgress): void {
    this.onBulkProgress?.(progress);
  }

  private buildPromptForRow(
    workflow: Workflow,
    row: Readonly<Record<string, string>>,
    goalOverride: string | undefined,
  ): string {
    return this.renderAgentPrompt(workflow, goalOverride, row);
  }

  buildAgentPrompt(
    workflowId: string,
    userGoalOverride?: string,
  ): string | null {
    const workflow = this.store.load(workflowId);
    if (!workflow) return null;
    return this.renderAgentPrompt(workflow, userGoalOverride, null);
  }

  private renderAgentPrompt(
    workflow: Workflow,
    userGoalOverride: string | undefined,
    row: Readonly<Record<string, string>> | null,
  ): string {
    const lines: string[] = [
      `You are reproducing a workflow that was previously recorded by a user.`,
      ``,
      `Workflow: "${workflow.name}"`,
      `Originally performed: ${new Date(workflow.createdAt).toLocaleString()}`,
      `Duration: ${Math.round(workflow.duration / 1000)}s`,
      ``,
    ];

    if (row) {
      lines.push(`--- CURRENT ROW DATA ---`);
      for (const [k, v] of Object.entries(row)) {
        lines.push(`  ${k}: ${JSON.stringify(v)}`);
      }
      lines.push(
        `Use these EXACT values in every "Type" step that came from a column. Do not invent or carry data from any prior row.`,
      );
      lines.push(``);
    }

    lines.push(`--- RECORDED STEPS ---`);

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
            const value = this.resolveStepValue(p.value, p.parameter, row);
            const fromCol = p.parameter
              ? ` (from column "${p.parameter.column}")`
              : "";
            lines.push(
              `${stepNum}. [${time}] Type ${JSON.stringify(value)} into ${p.tag}${labelPart}${fromCol}`,
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
        `Goal: Reproduce this workflow exactly. Start at "${workflow.startUrl}", follow the recorded steps in order. For each "Click" / "Type" / "Submit" step, use the exact selector shown — if the click action returns "Element not found", consult the interactive elements list and find the closest semantic match (same label or role), then continue. Treat the user's notes as intent guidance.${row ? ` When you finish, return a single-line summary in your final answer suitable for a CSV cell.` : ""}`,
      );
    }

    return lines.join("\n");
  }

  private resolveStepValue(
    recordedValue: string | undefined,
    parameter: { readonly column: string } | undefined,
    row: Readonly<Record<string, string>> | null,
  ): string {
    if (parameter && row) {
      const fromRow = row[parameter.column];
      if (fromRow !== undefined) return fromRow;
    }
    if (parameter && !row) {
      return `{{ currentRow.${parameter.column} }}`;
    }
    return recordedValue ?? "";
  }
}
