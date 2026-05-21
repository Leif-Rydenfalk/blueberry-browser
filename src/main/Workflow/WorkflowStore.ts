import { app } from "electron";
import {
  access,
  appendFile,
  mkdir,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { formatCsvRow } from "../../shared/csv";
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
  }

  async save(workflow: Workflow): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${workflow.id}.json`);
    await writeFile(file, JSON.stringify(workflow, null, 2), "utf-8");
  }

  async load(id: string): Promise<Workflow | null> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      const raw = await readFile(file, "utf-8");
      return JSON.parse(raw) as Workflow;
    } catch (error) {
      if (isMissingFile(error)) return null;
      console.error(`[WorkflowStore] Failed to load workflow ${id}:`, error);
      return null;
    }
  }

  async delete(id: string): Promise<boolean> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      await unlink(file);
    } catch (error) {
      if (isMissingFile(error)) return false;
      throw error;
    }
    // Best-effort cleanup of any per-workflow run artefacts.
    await rm(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  async rename(id: string, name: string): Promise<boolean> {
    const workflow = await this.load(id);
    if (!workflow) return false;
    await this.save({ ...workflow, name });
    return true;
  }

  async setDataset(id: string, dataset: WorkflowDataset): Promise<boolean> {
    const workflow = await this.load(id);
    if (!workflow) return false;
    await this.save({ ...workflow, dataset });
    return true;
  }

  async clearDataset(id: string): Promise<boolean> {
    const workflow = await this.load(id);
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
    const { dataset: _drop, ...withoutDataset } = next;
    void _drop;
    await this.save(withoutDataset as Workflow);
    return true;
  }

  async bindStepToColumn(
    id: string,
    stepId: string,
    column: string | null,
  ): Promise<boolean> {
    const workflow = await this.load(id);
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
    await this.save({ ...workflow, steps });
    return true;
  }

  async appendRunOutput(
    workflowId: string,
    runId: string,
    columns: ReadonlyArray<string>,
    row: Readonly<Record<string, string>>,
    answer: string,
    error?: string,
  ): Promise<string> {
    const runsDir = path.join(this.dir, workflowId, "runs");
    await mkdir(runsDir, { recursive: true });
    const csvPath = path.join(runsDir, `${runId}.csv`);

    // Header is written lazily on the first row of a run. We probe with
    // a non-throwing read instead of stat() — atomic enough for our use,
    // and avoids a separate import.
    const headerNeeded = !(await pathExists(csvPath));
    if (headerNeeded) {
      const headers = [...columns, "_answer", "_error"];
      await writeFile(csvPath, formatCsvRow(headers) + "\n", "utf-8");
    }

    const values = columns.map((c) => row[c] ?? "");
    const line = formatCsvRow([...values, answer || "", error || ""]);
    await appendFile(csvPath, line + "\n", "utf-8");
    return csvPath;
  }

  async listSummaries(): Promise<WorkflowSummary[]> {
    let entries;
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    const files = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".json"),
    );

    const summaries = await Promise.all(
      files.map(async (entry) => {
        try {
          const raw = await readFile(
            path.join(this.dir, entry.name),
            "utf-8",
          );
          const workflow = JSON.parse(raw) as Workflow;
          return {
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
          } satisfies WorkflowSummary;
        } catch {
          return null;
        }
      }),
    );

    return summaries
      .filter((s): s is WorkflowSummary => s !== null)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "ENOENT"
  );
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
}
