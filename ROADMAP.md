# Blueberry Browser — Productisation Roadmap

> From "AI guessing what to do" to "AI healing a deterministic workflow + handling bulk data."

The agent works, but it currently re-plans every recorded workflow from scratch using only
URLs and screenshots. That's slow, expensive, and unreliable. The five tracks below turn it
into something a business will pay for.

---

## Track 1 — True DOM Event Recording (Self-Healing Macros) *(shipped)*

### The problem
`WorkflowRecorder.captureNavigation()` only hooks `did-navigate` and
`did-navigate-in-page`. A click that opens a modal, a typed form field, or a select
dropdown change leaves zero trace in the recording. At replay time the agent has to
re-discover what the user did from the URL and a free-text annotation — slow, expensive,
and prone to hallucination.

### The fix
Inject a preload script during recording that listens for `click`, `input`, `change`,
and `submit` on `window`. For each event, capture:

- Best-quality selector: `id` → `data-testid` → unique `name` → CSS path → role+text.
- XPath as a fallback.
- Element tag, label/text, and a snippet of surrounding text.
- For `input`/`change`: the value (parameterizable, see Track 2).
- Viewport coordinates so coordinate-based replay also works.

Pipe events back to main via a dedicated IPC channel (`workflow:dom-event`). Store as a
new `WorkflowStepData` variant.

### Self-healing
At replay, the agent runs the recorded selector first. Only if it fails does the LLM
inspect the live page (interactive-elements list + screenshot) to locate the new element
semantically. On success, the recorded step is **rewritten** with the new selector so
the next run skips the LLM round-trip.

### Where it lives in the code
- `src/preload/tabRecorder.ts` — preload script attached to every tab's
  `WebContentsView`. Hooks `click`/`input`/`change`/`submit`/`keydown` in capture
  phase, computes selector + xpath + label, debounces input bursts (600 ms), and
  posts `workflow:dom-event` only while recording is active.
- `src/main/Tab.ts` — registers the preload via `webPreferences.preload`.
- `electron.vite.config.ts` — adds `tabRecorder` to the preload rollup inputs so
  it bundles to `out/preload/tabRecorder.js`.
- `src/main/Workflow/WorkflowTypes.ts` — `WorkflowInteractionData` variant,
  `DomEventPayload` interface, `DOM_EVENT` and `RECORDING_ACTIVE_CHANGED` channels.
- `src/main/Workflow/WorkflowRecorder.ts` — `captureInteraction()` appends a
  step; coalesces consecutive `input` events on the same selector so we keep
  only the final value the user typed.
- `src/main/Workflow/WorkflowIpcHandler.ts` — pipes IPC events into the
  recorder, broadcasts `recording-active-changed` to every tab on state changes
  (and to newly-created tabs while a recording is in flight), and rewrites
  `buildAgentPrompt()` to emit explicit `Click "Label" / Type "..." into / Submit`
  instructions with the selector and xpath alongside.
- `src/main/EventManager.ts` — `ipcMain.on(DOM_EVENT)` routes payloads to the
  handler.

The agent's natural recovery loop is what provides the "self-healing" today: if
a recorded selector returns "Element not found", `ActionExecutor` already
returns `recoverable: true`, the runner gives the agent another step, and the
existing interactive-elements list lets it pick the semantically-closest
element. The follow-up below covers persisting the healed selector back to the
workflow file so the next run skips the LLM round-trip entirely.

### Open follow-ups (not in this PR)
- **Persist healed selectors**: `WorkflowStore.updateStepSelector(workflowId, stepId, newSelector)`
  + an explicit `selector_drift` error tag the runner watches for, so successful
  fallbacks get written back to disk.
- **iframe recording**: `tabRecorder.ts` currently only sees main-frame events;
  a separate `setPreloads` injection inside same-origin frames would catch
  payment widgets and embedded forms.
- **Drag/drop and clipboard**: not yet captured.

### Why it ships money
Recorded workflows go from "AI guidance" to **deterministic playback** — the same
business-process automation customers buy from UiPath but driven by a real browser
and LLM-assisted recovery when the page changes.

---

## Track 2 — Bulk Data Parameterization ("Spreadsheet" feature)

### The problem
The agent runs one task at a time with a single hard-coded goal. Customers want to
send 500 outreach messages, not one.

### The fix
Attach a **dataset** to a workflow. Users upload a CSV (or paste rows) and bind columns
during recording:

- Right-click highlighted text → "Extract to column `companyName`".
- Click an input → "Type from column `email`".

The recorded steps store `{{ column }}` placeholders instead of literal values.
Execution becomes a loop over the dataset; each iteration substitutes `currentRow`.

### Where to code
- `src/main/Workflow/WorkflowTypes.ts` — add `WorkflowDataset` (rows, column names) and
  a `parameter` field on interaction steps: `{ source: "column", column: string }`.
- `src/main/Workflow/WorkflowStore` — store CSVs alongside the workflow JSON under
  `userData/workflows/{id}/dataset.csv`.
- `src/main/Agent/core/AgentOrchestrator.startSession` — accept `dataset: Row[]` and
  iterate (one runner invocation per row, or one runner that loops internally).
- `src/main/Agent/types/AgentTypes.ts` — add `currentRow?: Record<string, string>` to
  `AgentContext`.
- `src/main/Agent/prompts/systemPrompts.ts` — instruct the agent to substitute
  `{{ currentRow.column }}` and never reuse a prior row's data.
- Renderer: a CSV picker + a column-binding UI surfaced during the recording overlay,
  plus a "data preview" panel showing the first 5 rows.
- Output: each row's result appended to an export CSV
  (`userData/workflows/{id}/runs/{timestamp}.csv`).

### Why it ships money
Bulk = scale = revenue. Cold outreach, list enrichment, lead qualification, invoice
data entry — every B2B workflow people pay for has this shape.

---

## Track 3 — Background / Headless Execution

### The problem
`SingleTabStrategy` runs the agent in the **active** tab. While it runs, the user can't
do anything else with the browser — every interaction is hijacked.

### The fix
A `BackgroundStrategy` (or `MultiTabStrategy`) that spawns an off-screen
`WebContentsView` per concurrent run. The user keeps browsing in the foreground.

### Where to code
- New: `src/main/Agent/strategies/BackgroundStrategy.ts` implementing `TabStrategy`.
  Creates a hidden `WebContentsView`, attaches it to the window but never calls
  `show()`, runs `ActionExecutor` against it.
- `src/main/Agent/types/AgentTypes.ts` — extend the `mode` union with `"background"`.
- `src/main/Agent/core/AgentOrchestrator` — branch on `request.mode === "background"`
  to instantiate `BackgroundStrategy`.
- `src/main/Window.ts` — expose `createHiddenWebContents()` that returns a view with
  zero bounds and no parent attachment.
- Renderer: a "Run in background" toggle on the workflow run dialog; an
  "Active background runs" panel in the sidebar.
- For multi-row datasets (Track 2), spawn N parallel background views, capped by
  a concurrency setting (default 3).

### Why it ships money
The user keeps replying to email while the agent does 4 hours of CRM data entry.
That's the only way RPA-style automation is actually usable for knowledge workers.

---

## Track 4 — Human-in-the-Loop (HITL) Checkpoints

### The problem
The agent will happily click "Send" on 50 emails or "Pay" on a checkout. No business
that values its money will let an LLM act unsupervised on destructive actions.

### The fix
A `waitForApproval` action and a "destructive action" classifier:

- Any click on an element containing the text *Send*, *Pay*, *Submit*, *Delete*,
  *Confirm purchase*, etc., implicitly pauses the runner.
- The runner emits `agent:approval-required` over IPC with a description of the
  pending action and the current screenshot.
- Sidebar shows an Approval UI: "Approve once" / "Approve all in this run" / "Skip" /
  "Stop".
- Drafting + queueing pattern: agent prepares 50 drafts → pauses → user clicks
  "Approve all" → agent executes the queued sends.

### Where to code
- `src/main/Agent/types/AgentTypes.ts` — add `"waitForApproval"` to `ActionType` and
  `ApprovalParams { reason: string; previewData?: unknown }`.
- `src/main/Agent/core/AgentRunner.ts` — new `pendingApproval` state; loop blocks
  until renderer responds.
- `src/main/Agent/core/AgentIpcHandler.ts` — `agent:resolve-approval` channel.
- `src/main/Agent/core/ActionExecutor.ts` — pre-check on `click` / `type`: if the
  target element's text matches the destructive-keyword list and the runner isn't in
  "approve all" mode, transparently insert an approval gate.
- Renderer: a bottom-sheet approval modal (uses the existing pattern from `DESIGN.md §8`).

### Why it ships money
Removes the #1 objection to deploying LLM agents in business workflows. Buyers can say
yes because they can still see and approve the irreversible steps.

---

## Track 5 — Smart Multi-Element Extraction *(shipped)*

### The problem
`ActionExecutor.executeExtract()` accepts a single CSS selector + attribute. To scrape
a product list (title, price, link) the agent has to know the exact selectors in
advance — and one slip and it gets back the wrong column. For lists of 20+ items the
agent currently issues many round-trips and frequently formats inconsistently.

### The fix
A new action `extractSchema` that takes:

```jsonc
{
  "name": "products",                   // result key on the step
  "schema": {
    "title": "product title text",
    "price": "displayed price",
    "link":  "url"                      // 'url' is a hint → resolve to absolute href
  },
  "limit": 50,                          // optional, default 50
  "containerHint": "main product grid", // optional, free-text hint to the LLM
  "frame": "iframe#shop"                // optional, for iframes
}
```

Execution flow:

1. `ActionExecutor` gathers page context: URL, title, a truncated `body.outerHTML`
   (scripts/styles stripped), and the existing interactive-elements list.
2. Calls `LLMClient.generateText()` with a tightly scoped system prompt asking for a
   single self-invoking JS expression that returns a JSON array matching the schema.
3. Runs the generated expression in the page via `tab.runJs`.
4. Validates the result is an array; coerces fields to trimmed strings; resolves
   `url`-typed fields to absolute URLs.
5. Returns `{ [name]: rows }` as a normal `ActionResult.data`.

### Why this is the right shape
- **Schema-first**: the agent declares *what* it wants, not *how*. The LLM writes the
  scraping selector once per page-layout pair. Future calls on the same page reuse the
  cached scraper (caching is a follow-up — see "Open follow-ups").
- **Determinism after generation**: the scraper is plain JS. Once written, it returns
  identical results across runs of the same page.
- **Bypasses the recurring "extract one thing at a time" failure mode**: 1 LLM call +
  1 page eval beats 20 round-trips.

### Where it lives in the code
- `src/main/Agent/types/AgentTypes.ts` — `"extractSchema"` in `ActionType`,
  `ExtractSchemaParams` interface, `ActionParamsMap` entry.
- `src/main/Agent/core/ActionExecutor.ts` — constructor takes `LLMClient`,
  `executeExtractSchema()` method, `EXTRACT_SCHEMA_SYSTEM_PROMPT` guardrails,
  `samplePageStructure()` HTML-sample helper, IIFE wrapping + row
  normalisation.
- `src/main/Agent/strategies/SingleTabStrategy.ts` — accepts `LLMClient` and
  forwards it to the executor.
- `src/main/Agent/core/AgentOrchestrator.ts` — passes `sidebar.client` into
  `SingleTabStrategy`.
- `src/main/Agent/core/AgentRunner.ts` — `"extractSchema"` added to
  `SKIP_SCREENSHOT_ACTIONS`; working-memory entry tracks row count.
- `src/main/Agent/prompts/systemPrompts.ts` — STRUCTURED SCRAPING guidance
  section + the JSON example in the available-actions list.

### Open follow-ups (not in this PR)
- **Per-page scraper caching**: hash `(URL host + path pattern + schema)` and persist
  the generated function. First call costs an LLM round-trip; subsequent calls are
  pure JS eval.
- **Pagination loop**: a higher-level `extractAcrossPages` that drives "next" clicks
  between extractions.
- **Schema validation**: optional `type` per field (`string` / `number` / `url` /
  `bool`); coerce + drop rows that fail.

---

## Implementation order (recommended)

1. ~~**Track 5**~~ ✓ shipped — small, self-contained, immediate value on every scrape task.
2. ~~**Track 1**~~ ✓ shipped — gives Tracks 2 & 4 the real interaction data they need.
3. **Track 2 (next)** — turns recordings into bulk runs (the primary commercial use case).
4. **Track 4** — required before any customer trusts Track 2 in production.
5. **Track 3** — needed once concurrency matters; deferrable until the first 4 prove out.

---

*Last updated: 2026-05-19*
