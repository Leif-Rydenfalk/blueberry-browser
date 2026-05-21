// Thin wrappers over papaparse. Used by both main and renderer processes
// (workflow dataset import, bulk-run output writes, CSV preview rendering).
// Centralised so all callers share the same RFC-4180 handling.

import Papa from "papaparse";

export interface ParsedTable {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

export interface ParsedDataset {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<Readonly<Record<string, string>>>;
}

// 2-D matrix shape — preserves column order, no key lookup. Used for the
// CSV preview component where we render the raw header row + cell grid.
export function parseTable(text: string): ParsedTable {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: true,
  });
  const records = result.data;
  if (records.length === 0) return { header: [], rows: [] };
  const [header, ...rows] = records;
  return { header, rows };
}

// Keyed-row shape — used for dataset binding where steps reference rows by
// column name. Trims header cells and discards empty trailing columns.
export function parseDataset(text: string): ParsedDataset {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  const columns = (result.meta.fields ?? []).filter((c) => c.length > 0);
  const rows: Record<string, string>[] = [];
  for (const raw of result.data) {
    // Skip rows where every value is blank (Papa can emit these on trailing
    // newlines that survive skipEmptyLines for header:true mode).
    let hasContent = false;
    const trimmed: Record<string, string> = {};
    for (const col of columns) {
      const v = (raw[col] ?? "").trim();
      trimmed[col] = v;
      if (v.length > 0) hasContent = true;
    }
    if (hasContent) rows.push(trimmed);
  }
  return { columns, rows };
}

// Single-row write helper for streaming output (bulk-run CSV append). Papa's
// unparse is geared toward whole-table emission; for one-line writes we go
// through it with a single-record matrix so escaping stays consistent.
export function formatCsvRow(values: ReadonlyArray<string>): string {
  return Papa.unparse([values.map((v) => String(v ?? ""))], {
    newline: "",
  });
}
