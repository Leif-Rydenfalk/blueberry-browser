import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import * as path from "node:path";

export interface TokenUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

interface StoredData {
  inputTokens: number;
  outputTokens: number;
}

export class TokenUsageStore {
  private readonly file: string;
  private data: StoredData;

  constructor() {
    this.file = path.join(app.getPath("userData"), "token-usage.json");
    // Boot-time read. The file is a tiny two-integer JSON, so a sync read
    // during app.whenReady is acceptable here — writes go through fs/promises.
    this.data = this.loadSync();
  }

  async record(inputTokens: number, outputTokens: number): Promise<void> {
    this.data = {
      inputTokens: this.data.inputTokens + inputTokens,
      outputTokens: this.data.outputTokens + outputTokens,
    };
    await this.persist();
  }

  getTotals(): TokenUsageTotals {
    return {
      inputTokens: this.data.inputTokens,
      outputTokens: this.data.outputTokens,
      totalTokens: this.data.inputTokens + this.data.outputTokens,
    };
  }

  private loadSync(): StoredData {
    if (!existsSync(this.file)) return { inputTokens: 0, outputTokens: 0 };
    try {
      const parsed = JSON.parse(
        readFileSync(this.file, "utf-8"),
      ) as Partial<StoredData>;
      return {
        inputTokens: parsed.inputTokens ?? 0,
        outputTokens: parsed.outputTokens ?? 0,
      };
    } catch (error) {
      console.error("[TokenUsageStore] Failed to load:", error);
      return { inputTokens: 0, outputTokens: 0 };
    }
  }

  private async persist(): Promise<void> {
    try {
      await writeFile(this.file, JSON.stringify(this.data), "utf-8");
    } catch (error) {
      console.error("[TokenUsageStore] Failed to persist:", error);
    }
  }
}
