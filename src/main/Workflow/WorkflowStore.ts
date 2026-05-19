import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import type {
  Workflow,
  WorkflowStep,
  WorkflowSummary,
  WorkflowDataset,
} from "./WorkflowTypes";

export class WorkflowStore {
  private readonly dir: string;

  constructor() {
    this.dir = path.join(app.getPath("userData"), "workflows");
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  save(workflow: Workflow): void {
    const file = path.join(this.dir, `${workflow.id}.json`);
    fs.writeFileSync(file, JSON.stringify(workflow, null, 2), "utf-8");
  }

  load(id: string): Workflow | null {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf-8")) as Workflow;
    } catch (error) {
      console.error(`[WorkflowStore] Failed to load workflow ${id}:`, error);
      return null;
    }
  }

  delete(id: string): boolean {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    const runsDir = path.join(this.dir, id, "runs");
    if (fs.existsSync(runsDir)) {
      fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    }
    return true;
  }

  rename(id: string, name: string): boolean {
    const workflow = this.load(id);
    if (!workflow) return false;
    this.save({ ...workflow, name });
    return true;
  }

  setDataset(id: string, dataset: WorkflowDataset): boolean {
    const workflow = this.load(id);
    if (!workflow) return false;
    this.save({ ...workflow, dataset });
    return true;
  }

  clearDataset(id: string): boolean {
    const workflow = this.load(id);
    if (!workflow) return false;
    // Also drop any per-step parameter bindings that referenced the dataset.
    const steps = workflow.steps.map((step) => {
      if (step.data.type !== "interaction") return step;
      if (!step.data.payload.parameter) return step;
      const { parameter: _ignored, ...rest } = step.data.payload;
      void _ignored;
      return {
        ...step,
        data: { type: "interaction" as const, payload: rest },
      };
    });
    const next: Workflow = { ...workflow, steps };
    // Remove dataset by reconstructing without the key
    const { dataset: _drop, ...withoutDataset } = next;
    void _drop;
    this.save(withoutDataset as Workflow);
    return true;
  }

  bindStepToColumn(id: string, stepId: string, column: string | null): boolean {
    const workflow = this.load(id);
    if (!workflow) return false;
    let mutated = false;
    const steps: WorkflowStep[] = workflow.steps.map((step) => {
      if (step.id !== stepId) return step;
      if (step.data.type !== "interaction") return step;
      mutated = true;
      const payload = { ...step.data.payload };
      if (column === null) {
        delete (payload as { parameter?: { column: string } }).parameter;
      } else {
        (payload as { parameter?: { column: string } }).parameter = { column };
      }
      return {
        ...step,
        data: { type: "interaction" as const, payload },
      };
    });
    if (!mutated) return false;
    this.save({ ...workflow, steps });
    return true;
  }

  appendRunOutput(
    workflowId: string,
    runId: string,
    columns: ReadonlyArray<string>,
    row: Readonly<Record<string, string>>,
    answer: string,
    error?: string,
  ): string {
    const runsDir = path.join(this.dir, workflowId, "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const csvPath = path.join(runsDir, `${runId}.csv`);

    if (!fs.existsSync(csvPath)) {
      const headers = [...columns, "_answer", "_error"];
      fs.writeFileSync(csvPath, this.csvRow(headers) + "\n", "utf-8");
    }

    const values = columns.map((c) => row[c] ?? "");
    const line = this.csvRow([...values, answer || "", error || ""]);
    fs.appendFileSync(csvPath, line + "\n", "utf-8");
    return csvPath;
  }

  // RFC-4180 minimal: quote fields containing comma, quote, or newline.
  private csvRow(values: ReadonlyArray<string>): string {
    return values
      .map((raw) => {
        const s = String(raw ?? "");
        if (/[",\n\r]/.test(s)) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      })
      .join(",");
  }

  listSummaries(): WorkflowSummary[] {
    const entries = fs.readdirSync(this.dir, { withFileTypes: true });
    const summaries: WorkflowSummary[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const workflow = JSON.parse(
          fs.readFileSync(path.join(this.dir, entry.name), "utf-8"),
        ) as Workflow;
        summaries.push({
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          createdAt: workflow.createdAt,
          duration: workflow.duration,
          stepCount: workflow.stepCount,
          startUrl: workflow.startUrl,
          endUrl: workflow.endUrl,
          datasetRowCount: workflow.dataset?.rows.length,
          datasetColumns: workflow.dataset?.columns,
        });
      } catch {
        // Skip corrupt files
      }
    }

    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }
}
