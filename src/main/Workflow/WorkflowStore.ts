import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { Workflow, WorkflowSummary } from './WorkflowTypes';

export class WorkflowStore {
  private readonly dir: string;

  constructor() {
    this.dir = path.join(app.getPath('userData'), 'workflows');
    if (!fs.existsSync(this.dir)) {
      fs.mkdirSync(this.dir, { recursive: true });
    }
  }

  save(workflow: Workflow): void {
    const file = path.join(this.dir, `${workflow.id}.json`);
    fs.writeFileSync(file, JSON.stringify(workflow, null, 2), 'utf-8');
  }

  load(id: string): Workflow | null {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8')) as Workflow;
    } catch (error) {
      console.error(`[WorkflowStore] Failed to load workflow ${id}:`, error);
      return null;
    }
  }

  delete(id: string): boolean {
    const file = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  rename(id: string, name: string): boolean {
    const workflow = this.load(id);
    if (!workflow) return false;
    this.save({ ...workflow, name });
    return true;
  }

  listSummaries(): WorkflowSummary[] {
    const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
    const summaries: WorkflowSummary[] = [];

    for (const file of files) {
      try {
        const workflow = JSON.parse(
          fs.readFileSync(path.join(this.dir, file), 'utf-8')
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
        });
      } catch {
        // Skip corrupt files
      }
    }

    return summaries.sort((a, b) => b.createdAt - a.createdAt);
  }
}
