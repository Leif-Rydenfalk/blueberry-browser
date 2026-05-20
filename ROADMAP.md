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

## Track 2 — Bulk Data Parameterization ("Spreadsheet" feature) *(shipped)*

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

### Where it lives in the code
- `src/main/Workflow/WorkflowTypes.ts` — `WorkflowDataset { columns, rows }`,
  `parameter?: { column }` on `WorkflowInteractionData`, `BulkRunProgress` /
  `BulkRunResult` types, plus channels `SET_DATASET`, `CLEAR_DATASET`,
  `SET_RECORDING_DATASET`, `BIND_STEP_TO_COLUMN`, `EXECUTE_BULK`,
  `BULK_RUN_PROGRESS`, `BULK_RUN_COMPLETE`, `ABORT_BULK`.
- `src/main/Workflow/WorkflowStore.ts` — `setDataset` / `clearDataset` /
  `bindStepToColumn` mutate the workflow JSON in place; `appendRunOutput`
  writes per-run CSVs to `userData/workflows/{id}/runs/{runId}.csv` with the
  dataset columns plus `_answer` / `_error` columns.
- `src/main/Workflow/WorkflowRecorder.ts` — holds an "active dataset" during
  a recording session (persisted onto the saved workflow at stop time);
  `bindLatestInteraction` rewrites the most-recent matching step's
  `parameter` field, with a pending-binding map for right-clicks that
  happen *before* the user types; `hookTab` listens for `context-menu` on
  editable elements and pops a Bind submenu built from the dataset columns.
- `src/main/Workflow/WorkflowIpcHandler.ts` — minimal RFC-4180 CSV parser,
  `attachDataset` / `clearDataset` / `setRecordingDataset` /
  `bindStepToColumn` / `executeBulk` / `abortBulk`, plus a private
  `renderAgentPrompt(workflow, override, row)` that emits the current row
  values into every `Type` step bound to a column (with a fallback
  `{{ currentRow.column }}` placeholder when no row is supplied).
- `src/main/Agent/core/AgentOrchestrator.ts` — `runOneShot(goal)` returns a
  Promise that resolves with the final-answer string when the runner
  completes, which the bulk loop awaits per row.
- `src/main/EventManager.ts` — wires the new IPC channels, streams
  `BULK_RUN_PROGRESS` / `BULK_RUN_COMPLETE` to the sidebar, and hands the
  orchestrator to the workflow handler at construction time.
- `src/preload/sidebar.ts` (+ `.d.ts`) — exposes `setWorkflowDataset`,
  `clearWorkflowDataset`, `setRecordingDataset`, `bindStepToColumn`,
  `executeBulkWorkflow`, `abortBulkWorkflow`, plus `onBulkRunProgress` /
  `onBulkRunComplete` listeners.
- `src/renderer/sidebar/src/contexts/WorkflowContext.tsx` — new state for
  `recordingDataset`, `bulkProgress`, `bulkResult`; actions for attach /
  clear / bind / bulk execute / abort.
- `src/renderer/sidebar/src/components/WorkflowPanel.tsx` — new
  `DatasetUploader` (file pick + paste, parses CSV client-side); a "Attach
  data (CSV)" link inside the recording bar that drives in-page
  right-click binding; a new `WorkflowDetailView` opened from each card's
  "Open" button, with a dataset section (first-5-rows preview, "Run for
  all N rows" button, live row-by-row progress bar, output path on
  completion) and a per-step "from column ▾" dropdown for every
  interaction step.

### Open follow-ups (not in this PR)
- **"Extract to column"** for highlighted text — a new step variant that
  captures text per row and writes it back to the run CSV, complementing
  the input-binding direction already shipped.
- **Concurrent rows** — currently the bulk loop is serial. Once Track 3
  (background tabs) lands, run K rows in parallel against hidden
  WebContentsViews.
- **Resumable runs** — if a row fails halfway, surface a "retry failed
  rows" button instead of forcing a full rerun.

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

## Track 4 — Human-in-the-Loop (HITL) Checkpoints *(shipped)*

### The problem
The agent will happily click "Send" on 50 emails or "Pay" on a checkout. No business
that values its money will let an LLM act unsupervised on destructive actions.

### The fix
A `waitForApproval` action and a destructive-action classifier:

- Any `click`/`type`/`key` whose target element label or whose agent reasoning
  contains a destructive keyword (Send, Pay, Submit, Delete, Confirm, Publish,
  Transfer, etc.) implicitly pauses the runner before the action runs.
- The runner emits `agent:approval-required` over IPC with the proposed action,
  the matched keyword, the element's resolved label, and a fresh screenshot.
- Sidebar shows a bottom-sheet Approval UI: "Approve once" / "Approve all in
  this run" / "Skip" / "Stop run".
- Drafting + queueing pattern: the agent can also call `waitForApproval` itself
  with a `reason` and `previewData` (the drafted message, etc.) — useful for
  batching ("prepare all 50 drafts → pause once → user approves the batch").

### Where it lives in the code
- `src/main/Agent/types/AgentTypes.ts` — `"waitForApproval"` in `ActionType`,
  `WaitForApprovalParams`, `ApprovalDecision`, `ApprovalRequest`,
  `ApprovalResolved`, plus an optional `getActionLabel(action)` on
  `TabStrategy` that resolves the target element's visible label.
- `src/main/Agent/core/ApprovalGate.ts` — `DESTRUCTIVE_KEYWORDS` list,
  `classifyActionByText()` (scans reasoning + params), and
  `classifyElementLabel()` (scans the live element label).
- `src/main/Agent/strategies/SingleTabStrategy.ts` — implements
  `getActionLabel()` via `tab.runJs` (selector path) or `elementFromPoint`
  (coordinate path).
- `src/main/Agent/core/AgentRunner.ts` — `pendingApproval` state,
  `approveAllForRun` flag, `maybeRequestApproval()` runs before each
  `executeAction`. Decisions: `approve-once` / `approve-all` proceed,
  `skip` records a skipped step and continues, `stop` finishes the run.
  `resolveApproval(id, decision)` resolves the promise from the renderer.
  `abort()` also resolves any in-flight approval with `stop`.
- `src/main/Agent/core/AgentOrchestrator.ts` — `setApprovalCallback()`,
  `resolveApproval()`, `getPendingApproval()`; bakes `sessionId` into every
  emitted request.
- `src/main/Agent/core/AgentIpcHandler.ts` — fans approval events out to
  any number of listeners and exposes resolver methods.
- `src/main/EventManager.ts` — `agent:approval-required` push channel and
  `agent:resolve-approval` / `agent:get-pending-approval` invoke channels.
- `src/preload/sidebar.ts` (+ `.d.ts`) — `onAgentApprovalRequired`,
  `resolveAgentApproval`, `getPendingAgentApproval`.
- `src/renderer/sidebar/src/contexts/AgentContext.tsx` — `pendingApproval`
  state, `resolveApproval()` action, recovery via `getPendingAgentApproval`
  on mount.
- `src/renderer/sidebar/src/components/ApprovalSheet.tsx` — bottom-sheet
  modal with the proposed action, target label, matched keyword chip, page
  screenshot, and the four decision buttons.
- `src/main/Agent/prompts/systemPrompts.ts` — documents `waitForApproval`
  and tells the model that destructive-button clicks are auto-gated.

### Open follow-ups (not in this PR)
- **Per-workflow approval policy**: let a saved workflow declare "always
  require approval at this step" so even non-keyword clicks pause.
- **Approval audit log**: persist `{actionId, decision, user, timestamp}`
  to disk for compliance review.
- **Tunable keyword list**: expose `DESTRUCTIVE_KEYWORDS` as a settings
  panel so each tenant can add their own (e.g. "Wire Funds").

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

## Track 6 — MCP Delegation Endpoint *(shipped)*

### The problem
Blueberry's agent is locked inside the Blueberry desktop app. A useful
agent-of-agents (Hermes, a Claude project, an n8n flow, a cron job) has no way
to say *"hey Blueberry, message Leif on LinkedIn for me"* and await a result.
The agent is a feature of one app instead of a callable runtime.

### The fix
Expose Blueberry over the [Model Context Protocol](https://modelcontextprotocol.io)
so any other agent on the system can delegate web-UI tasks to it. The
minimum-viable surface is one tool:

```ts
delegate_task({ task: string }) → { sessionId, status, answer, stepCount, url, error? }
```

Two transports ship in parallel:

- **HTTP + SSE on localhost** (default port 7777, env-configurable). Natural
  for Electron — the main process can bind a port without becoming a child
  process. SSE streams live progress so the caller renders a progress bar
  instead of staring at a spinner.
- **stdio bridge** — a tiny companion CLI (`out/mcp-stdio.js`) that external
  agents spawn as a child process; it proxies stdio MCP into HTTP+SSE calls
  against the running Blueberry. Matches the "standard MCP" pattern most
  agent frameworks expect today.

The destructive-action gate from Track 4 still runs locally — a remote agent
cannot auto-approve "Send" or "Pay." The human at the Blueberry desktop is
always the source of truth for irreversible steps.

### Where it lives in the code
- `src/main/Mcp/McpTypes.ts` — MCP JSON-RPC envelopes, the `delegate_task`
  tool schema, `MCP_CHANNELS` for renderer-facing IPC events
  (`mcp:status-changed`, `mcp:request-received`, `mcp:request-completed`).
- `src/main/Mcp/McpHandler.ts` — implements `delegate_task` by calling
  `AgentOrchestrator.runOneShot(goal)`, returning the structured envelope.
  Also serializes inbound requests so a second delegation while one is in
  flight is queued (or rejected with `agent_busy`).
- `src/main/Mcp/McpServer.ts` — Node `http`-based HTTP+SSE server. Routes
  `POST /mcp` (one-shot JSON-RPC), `GET /mcp/sse` (streaming progress),
  `GET /healthz` (liveness). Speaks MCP `initialize` → `tools/list` →
  `tools/call`.
- `src/main/Mcp/blueberryMcpCli.ts` — stdio bridge entry. Bundles to
  `out/mcp-stdio.js`. Reads JSON-RPC from stdin, fetches the local HTTP
  endpoint, writes responses to stdout. Reports `server_unreachable`
  cleanly if Blueberry isn't running.
- `src/main/index.ts` — boots `McpServer` after the window is ready;
  cleans it up on `window-all-closed`.
- `electron.vite.config.ts` — adds `mcp-stdio` to the main process rollup
  inputs so it builds alongside `out/main/index.js`.
- `src/preload/sidebar.ts` (+ `.d.ts`) — exposes `onMcpStatusChanged`,
  `onMcpRequestReceived`, `onMcpRequestCompleted`, `getMcpStatus`.
- `src/renderer/sidebar/src/components/McpStatusBadge.tsx` — sidebar
  indicator: shows port + listening state + recent delegation count.

### Open follow-ups (not in this PR)
- **Auth token** for the HTTP endpoint, so a non-localhost deployment is
  safe. v1 binds 127.0.0.1 only.
- **More tools**: `list_workflows`, `run_workflow(id, dataset?)` so callers
  can hit deterministic recordings when one exists.
- **Reverse-delegation**: let a remote agent answer the human's approval
  prompt via a second MCP tool (the user already opted *not* to do this in
  v1 — humans approve locally — but it's the right v2 question).
- **Persistent allow-list** of caller identities, so multiple agents on the
  same machine can be told apart in the sidebar UI.

### Why it ships money
Blueberry stops being "a browser with AI" and becomes **the human-equivalent
web-action runtime that other agents call into**. Every agent stack on the
market wants a way to do real browser tasks — sending the LinkedIn message,
filing the expense report, scraping the gated dashboard — and Blueberry is
the one that does it like a person, on the user's actual logged-in browser,
with a human in the loop for destructive actions. That's a sellable product
category, not just a feature.

---

## Implementation order (recommended)

1. ~~**Track 5**~~ ✓ shipped — small, self-contained, immediate value on every scrape task.
2. ~~**Track 1**~~ ✓ shipped — gives Tracks 2 & 4 the real interaction data they need.
3. ~~**Track 2**~~ ✓ shipped — workflows now loop over a CSV with per-step column bindings.
4. ~~**Track 4**~~ ✓ shipped — destructive-action gate + bottom-sheet approval UI.
5. ~~**Track 6**~~ ✓ shipped — MCP delegation endpoint so outside agents can hand off web-UI tasks.
6. **Track 3** — needed once concurrency matters; deferrable until the first 4 prove out.

---

*Last updated: 2026-05-20*
