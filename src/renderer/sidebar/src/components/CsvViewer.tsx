import React, { useMemo, useState } from "react";
import { Copy, Check, Download, Table2, FileText } from "lucide-react";
import { cn } from "@common/lib/utils";

interface CsvViewerProps {
  readonly csv: string;
  readonly title?: string;
}

interface ParsedCsv {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

// Single-pass CSV parser — handles quoted cells with embedded commas / quotes /
// newlines per RFC 4180. The agent's bucketToCsvSection emits this format.
function parseCsv(text: string): ParsedCsv {
  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      records.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    records.push(row);
  }
  if (records.length === 0) return { header: [], rows: [] };
  return { header: records[0], rows: records.slice(1) };
}

export const CsvViewer: React.FC<CsvViewerProps> = ({ csv, title }) => {
  const parsed = useMemo(() => parseCsv(csv.trim()), [csv]);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"table" | "raw">("table");

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error("[CsvViewer] clipboard write failed:", error);
    }
  };

  const download = (): void => {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(title || "data").replace(/[^a-z0-9_-]+/gi, "_")}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const rowCount = parsed.rows.length;
  const colCount = parsed.header.length;

  return (
    <div className="my-2 rounded-xl border border-border/60 bg-background overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/50 bg-secondary/40">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-foreground truncate">
            {title || "Spreadsheet"}
          </span>
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
            {rowCount} rows · {colCount} cols
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => setView(view === "table" ? "raw" : "table")}
            className={cn(
              "size-7 rounded-lg flex items-center justify-center",
              "text-muted-foreground hover:text-foreground hover:bg-muted",
              "transition-colors cursor-pointer",
            )}
            title={view === "table" ? "Show raw CSV" : "Show table"}
          >
            {view === "table" ? (
              <FileText className="size-3.5" />
            ) : (
              <Table2 className="size-3.5" />
            )}
          </button>
          <button
            onClick={download}
            className={cn(
              "size-7 rounded-lg flex items-center justify-center",
              "text-muted-foreground hover:text-foreground hover:bg-muted",
              "transition-colors cursor-pointer",
            )}
            title="Download as .csv"
          >
            <Download className="size-3.5" />
          </button>
          <button
            onClick={copy}
            className={cn(
              "size-7 rounded-lg flex items-center justify-center",
              "transition-colors cursor-pointer",
              copied
                ? "text-green-500 bg-green-500/10"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            )}
            title={copied ? "Copied!" : "Copy CSV"}
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </div>
      </div>

      {view === "table" && colCount > 0 ? (
        <div className="overflow-auto max-h-[60vh]">
          <table className="text-xs w-full border-collapse">
            <thead className="sticky top-0 bg-secondary/80 backdrop-blur-sm">
              <tr>
                {parsed.header.map((h, i) => (
                  <th
                    key={`h-${i}`}
                    className="px-2.5 py-1.5 text-left font-semibold text-foreground border-b border-border/60 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parsed.rows.map((r, ri) => (
                <tr
                  key={`r-${ri}`}
                  className="hover:bg-secondary/30 transition-colors"
                >
                  {parsed.header.map((_, ci) => (
                    <td
                      key={`c-${ri}-${ci}`}
                      className="px-2.5 py-1 border-b border-border/30 text-foreground/90 whitespace-nowrap tabular-nums"
                    >
                      {r[ci] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className="max-h-[60vh] overflow-auto p-3 text-[11px] font-mono text-foreground/90 bg-background">
          {csv}
        </pre>
      )}
    </div>
  );
};
