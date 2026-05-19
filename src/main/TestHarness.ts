/**
 * TestHarness — runs the agent test suite inside the live Electron browser.
 *
 * Activated with `electron . --test` (or `pnpm test`).
 * Each task gets a real Electron WebContents and a real LLM call.
 *
 * Usage:
 *   pnpm test                 Run all tasks, window hidden
 *   pnpm test:visible         Same but window stays visible (watch mode)
 *   pnpm test --filter=name   Run only tasks whose name contains "name"
 */

import { app, BaseWindow } from "electron";
import * as fs from "fs";
import * as path from "path";
import type { Window } from "./Window";
import { AgentOrchestrator } from "./Agent/core/AgentOrchestrator";
import type { AgentStreamUpdate } from "./Agent/types/AgentTypes";
import { TEST_TASKS, type TestTask, type TestValidation } from "./testTasks";

// ─── Colours (ANSI) ──────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  grey: "\x1b[90m",
};

function c(color: keyof typeof C, text: string): string {
  return `${C[color]}${text}${C.reset}`;
}

// ─── Result types ─────────────────────────────────────────────────────────────

interface TaskResult {
  readonly task: TestTask;
  readonly passed: boolean;
  readonly skipped: boolean;
  readonly steps: number;
  readonly durationMs: number;
  readonly answer: string;
  readonly validation?: TestValidation;
  readonly error?: string;
  readonly stepLog: StepLogEntry[];
}

interface StepLogEntry {
  readonly stepNum: number;
  readonly action: string;
  readonly params: string;
  readonly status: "running" | "success" | "error" | "pending";
  readonly result?: string;
  readonly durationMs: number;
}

// ─── TestHarness ─────────────────────────────────────────────────────────────

export class TestHarness {
  private readonly window: Window;
  private readonly filter: string | null;

  constructor(window: Window) {
    this.window = window;
    const args = process.argv.slice(2);
    const filterArg = args.find((a) => a.startsWith("--filter="));
    this.filter = filterArg ? filterArg.replace("--filter=", "") : null;
  }

  async run(): Promise<void> {
    const tasks = this.filter
      ? TEST_TASKS.filter((t) => t.name.includes(this.filter!))
      : TEST_TASKS;

    if (tasks.length === 0) {
      console.log(c("red", `No tasks match filter "${this.filter}"`));
      app.exit(1);
      return;
    }

    this.printBanner(tasks.length);

    const results: TaskResult[] = [];
    for (const task of tasks) {
      const result = await this.runTask(task);
      results.push(result);
      this.printTaskResult(result);
    }

    this.printSummary(results);
    this.writeReport(results);

    const failed = results.filter((r) => !r.passed && !r.skipped).length;
    app.exit(failed > 0 ? 1 : 0);
  }

  // ─── Run one task ───────────────────────────────────────────────────────────

  private async runTask(task: TestTask): Promise<TaskResult> {
    console.log(
      `\n${c("bold", c("cyan", "▶"))} ${c("bold", task.name)} ${c("dim", `(${(task.timeoutMs / 1000).toFixed(0)}s budget)`)}`
    );

    const stepLog: StepLogEntry[] = [];
    let answer = "";
    let steps = 0;
    let error: string | undefined;
    const startMs = Date.now();

    try {
      // Fresh tab for each test (navigating to about:blank resets state)
      if (!task.keepCurrentPage) {
        const tab = this.window.activeTab;
        if (tab) {
          await tab.loadURL("about:blank").catch(() => {});
          await this.sleep(500);
        }
      }

      const orchestrator = new AgentOrchestrator(this.window);

      // Auto-approve HITL gates in test mode — no human present to review.
      // This lets the agent test executeScript and waitForApproval flows end-to-end.
      orchestrator.setApprovalCallback((request) => {
        console.log(`  ${c("yellow", "⚡")} ${c("dim", `Auto-approving HITL gate: ${request.reason.substring(0, 60)}`)}`);
        orchestrator.resolveApproval(request.id, "approve-all");
      });
      orchestrator.setScriptReviewCallback((request) => {
        console.log(`  ${c("yellow", "⚡")} ${c("dim", `Auto-approving script review: ${request.description.substring(0, 60)}`)}`);
        orchestrator.resolveScriptReview(request.id, { decision: "approve" });
      });

      // Wire up step logging
      let lastStepStart = Date.now();
      orchestrator.setStreamCallback((update: AgentStreamUpdate) => {
        const now = Date.now();
        if (update.status === "running") {
          lastStepStart = now;
          const params = this.formatParams(update.action.params);
          console.log(
            `  ${c("yellow", "→")} ${c("bold", update.action.type)}${params ? c("dim", `(${params})`) : ""}`
          );
        } else if (update.status === "success" || update.status === "error") {
          const ms = now - lastStepStart;
          const icon = update.status === "success" ? c("green", "✓") : c("red", "✗");
          const resultSnippet = this.formatResult(update.result);
          console.log(`  ${icon} ${c("grey", `${ms}ms`)} ${resultSnippet}`);

          stepLog.push({
            stepNum: update.step,
            action: update.action.type,
            params: JSON.stringify(update.action.params).substring(0, 120),
            status: update.status,
            result: resultSnippet,
            durationMs: ms,
          });

          steps = Math.max(steps, update.step);

          // Capture final answer from finish action
          if (update.action.type === "finish") {
            const finishParams = update.action.params as { answer?: string };
            answer = finishParams.answer ?? "";
          }
        }
      });

      // Run with timeout
      const sessionPromise = orchestrator.startSession({
        goal: task.goal,
        mode: "single-tab",
      });

      const timeoutPromise = this.sleep(task.timeoutMs).then(() => {
        orchestrator.abortSession();
        throw new Error(`Task timed out after ${task.timeoutMs / 1000}s`);
      });

      await Promise.race([sessionPromise, timeoutPromise]);

      // Wait for the agent to finish (startSession is async but runner runs in background)
      await this.waitForCompletion(orchestrator, task.timeoutMs - (Date.now() - startMs));

      // Extract final answer if not captured yet via stream
      if (!answer) {
        const session = orchestrator.getActiveSession();
        if (session) {
          const finishStep = [...session.steps].reverse().find(
            (s) => s.action.type === "finish",
          );
          if (finishStep) {
            answer = (finishStep.action.params as { answer?: string }).answer ?? "";
          }
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.log(`  ${c("red", "✗ Error:")} ${error}`);
    }

    const durationMs = Date.now() - startMs;

    // Run validator
    let validation: TestValidation | undefined;
    if (task.validate && !error) {
      try {
        validation = task.validate(answer, steps);
      } catch (err) {
        validation = {
          pass: false,
          reason: `Validator threw: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    const passed = !error && (!validation || validation.pass);

    return {
      task,
      passed,
      skipped: false,
      steps,
      durationMs,
      answer,
      validation,
      error,
      stepLog,
    };
  }

  private async waitForCompletion(
    orchestrator: AgentOrchestrator,
    remainingMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, remainingMs);
    while (orchestrator.isRunning() && Date.now() < deadline) {
      await this.sleep(200);
    }
  }

  // ─── Formatting helpers ─────────────────────────────────────────────────────

  private formatParams(params: unknown): string {
    if (!params || typeof params !== "object") return "";
    const entries = Object.entries(params as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => {
        const str = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}=${str.substring(0, 50)}`;
      });
    return entries.join(", ");
  }

  private formatResult(result: AgentStreamUpdate["result"]): string {
    if (!result) return "";
    if (!result.success) {
      return c("red", `error: ${result.error?.substring(0, 80) ?? "unknown"}`);
    }
    const data = result.data;
    if (!data) return c("green", "ok");
    const str = typeof data === "string" ? data : JSON.stringify(data);
    return c("grey", str.substring(0, 100));
  }

  // ─── Output ─────────────────────────────────────────────────────────────────

  private printBanner(count: number): void {
    console.log(
      `\n${c("bold", "🫐 Blueberry Agent Test Suite")}  ${c("dim", `${count} tasks`)}`
    );
    if (this.filter) console.log(c("yellow", `  filter: ${this.filter}`));
    console.log(c("dim", "─".repeat(60)));
  }

  private printTaskResult(result: TaskResult): void {
    const dur = `${(result.durationMs / 1000).toFixed(1)}s`;
    const stepStr = `${result.steps} step${result.steps !== 1 ? "s" : ""}`;

    if (result.error) {
      console.log(`\n  ${c("red", "FAIL")} — ${c("dim", result.error)}`);
      return;
    }

    if (result.validation) {
      const icon = result.validation.pass ? c("green", "PASS") : c("red", "FAIL");
      const reason = result.validation.pass ? "" : c("dim", ` — ${result.validation.reason}`);
      console.log(`  ${icon} ${c("grey", dur)} ${c("grey", stepStr)}${reason}`);
    } else {
      console.log(`  ${c("green", "PASS")} ${c("grey", dur)} ${c("grey", stepStr)}`);
    }

    if (result.answer) {
      const snippet = result.answer.replace(/\n+/g, " ").substring(0, 200);
      console.log(`  ${c("dim", "answer:")} ${c("grey", snippet)}`);
    }
  }

  private printSummary(results: TaskResult[]): void {
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed && !r.skipped).length;
    const total = results.length;
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    console.log("\n" + c("dim", "─".repeat(60)));
    console.log(
      `${c("bold", "Results:")} ${c("green", `${passed} passed`)}  ${failed > 0 ? c("red", `${failed} failed`) : c("grey", "0 failed")}  ${c("dim", `/ ${total} total`)}  ${c("dim", `${(totalMs / 1000).toFixed(1)}s`)}`
    );

    if (failed > 0) {
      console.log(`\n${c("red", "Failed tasks:")}`);
      results
        .filter((r) => !r.passed && !r.skipped)
        .forEach((r) => {
          const reason = r.error ?? r.validation?.reason ?? "no validator";
          console.log(`  ${c("red", "✗")} ${r.task.name} — ${c("dim", reason)}`);
        });
    }

    console.log();
  }

  // ─── JSON report ────────────────────────────────────────────────────────────

  private writeReport(results: TaskResult[]): void {
    try {
      const reportsDir = path.join(
        app.getPath("userData"),
        "test-reports",
      );
      fs.mkdirSync(reportsDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const reportPath = path.join(reportsDir, `report-${timestamp}.json`);

      const report = {
        timestamp: new Date().toISOString(),
        passed: results.filter((r) => r.passed).length,
        failed: results.filter((r) => !r.passed && !r.skipped).length,
        total: results.length,
        tasks: results.map((r) => ({
          name: r.task.name,
          passed: r.passed,
          steps: r.steps,
          durationMs: r.durationMs,
          answer: r.answer.substring(0, 500),
          validation: r.validation,
          error: r.error,
          stepLog: r.stepLog,
        })),
      };

      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(c("dim", `  Report written to: ${reportPath}`));
    } catch (err) {
      console.error("Failed to write test report:", err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/** Returns true if the app was launched in test mode. */
export function isTestMode(): boolean {
  return process.argv.includes("--test");
}

/**
 * Creates a minimal Electron window for tests (hidden by default) and runs
 * the test harness. Exits when done.
 */
export async function runTestMode(window: Window): Promise<void> {
  const showWindow = process.argv.includes("--test-visible") ||
    process.argv.includes("--visible");

  if (!showWindow) {
    // Hide window — tests run silently unless --test-visible
    const baseWin = (window as unknown as { _baseWindow: BaseWindow })._baseWindow;
    baseWin?.hide?.();
  }

  const harness = new TestHarness(window);
  await harness.run();
}
