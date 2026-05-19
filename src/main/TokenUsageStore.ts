import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

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
    this.data = this.load();
  }

  record(inputTokens: number, outputTokens: number): void {
    this.data = {
      inputTokens: this.data.inputTokens + inputTokens,
      outputTokens: this.data.outputTokens + outputTokens,
    };
    this.persist();
  }

  getTotals(): TokenUsageTotals {
    return {
      inputTokens: this.data.inputTokens,
      outputTokens: this.data.outputTokens,
      totalTokens: this.data.inputTokens + this.data.outputTokens,
    };
  }

  private load(): StoredData {
    if (!fs.existsSync(this.file)) return { inputTokens: 0, outputTokens: 0 };
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf-8"),
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

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data), "utf-8");
    } catch (error) {
      console.error("[TokenUsageStore] Failed to persist:", error);
    }
  }
}
