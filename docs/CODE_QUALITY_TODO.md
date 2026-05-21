# Code Quality Todo

Pre-submission cleanup pass. Each item is independently shippable; work them in order — earlier items have higher value-per-minute and lower risk.

Status legend: ☐ todo · ◐ in progress · ☑ done

---

## 1. ☑ Delete dead code (AgentRunner + systemPrompts)

**Files to delete**
- `src/main/Agent/core/AgentRunner.ts` — 1237 LOC, class never instantiated anywhere
- `src/main/Agent/prompts/systemPrompts.ts` — 518 LOC, only imported by the dead AgentRunner

**Verification done**
- `grep "new AgentRunner"` → 0 hits
- `AgentOrchestrator.ts` imports and constructs only `McpAgentRunner`
- `buildSystemPrompt` from `systemPrompts.ts` is imported only by `AgentRunner.ts:22` (the dead file itself)
- `McpAgentRunner` builds its system prompt internally at `McpAgentRunner.ts:1652`
- No test directory exists; no tests reference these files

**Side effects**
- The `src/main/Agent/prompts/` directory becomes empty — remove it too
- `CODING_STANDARDS.md §6` references `AgentRunner` / `ActionExecutor.dispatch()` / `systemPrompts.ts` as the live architecture — needs the rewrite in item 2

**Risk:** zero. No behavior change.

---

## 2. ☑ Refresh `CODING_STANDARDS.md §6` (Agent System)

Current text describes the obsolete JSON-parsing loop. Rewrite to match the live architecture:

- **Agent loop** is `McpAgentRunner` (Vercel AI SDK v5 `generateText` with native tool use + `stopWhen`), not a manual JSON parser
- **Tool registry**: `McpAgentRunner.buildTools()` declares the AI SDK tool surface. Each tool's `execute()` calls into `SingleTabStrategy`, which delegates raw actions to `ActionExecutor`
- **System prompt** is built inside `McpAgentRunner` (one method, not a module); chat-side prompt building is separate in `LLMClient.buildSystemPrompt()`
- **Extending actions**: add the tool to `buildTools()` in `McpAgentRunner`, add an executor case in `ActionExecutor.dispatch()` if a new raw action is needed, surface the type via `ActionParamsMap`

---

## 3. ☑ Async I/O in main-process stores

Three files use synchronous `fs` calls on the main thread. Convert to `fs/promises`.

| File | What it does sync today | Hot path? |
|---|---|---|
| `src/main/Workflow/WorkflowStore.ts` | `appendFileSync` **per row** during bulk runs (`appendRunOutput`, line 127); plus all CRUD in `save`/`load`/`delete`/`listSummaries` | **YES** — 500-row bulk run = 500 main-thread blocks |
| `src/main/Settings/SettingsStore.ts` | `readFileSync`/`writeFileSync` on every settings/API-key change | user-pace, not hot |
| `src/main/TokenUsageStore.ts` | `writeFileSync` on every LLM response token-usage record | per-LLM-call, noticeable in long runs |
| `src/main/TestHarness.ts:403,446` | Sync mkdir + writeFile when emitting reports | dev-only path, lowest priority |

**Approach**
- Switch to `import { readFile, writeFile, appendFile, mkdir, unlink, rm, readdir } from "fs/promises"`
- Make `save` / `load` / `appendRunOutput` / `setApiKey` / `record` / `persist` async
- Update all call sites and IPC handlers to `await`
- Verify with `npm run typecheck`

---

## 4. ☑ Consolidate CSV parsing with `papaparse`

Replaced **four** hand-rolled implementations with `src/shared/csv.ts` (parseTable + parseDataset + formatCsvRow wrappers over papaparse). Added `src/shared/**/*` to both tsconfigs.

The fifth callsite I had flagged — `AgentContext.tsx:21` — turned out NOT to be a real parser: it's a row-count summariser inside a context-compression pass (`csv.trim().split("\n")` to estimate row count for a markdown CSV code block). Forcing papaparse there would be over-engineering for a tolerant heuristic.

**Behavioural delta noted:** papaparse's `unparse` quotes leading/trailing whitespace where the old `csvRow` didn't. This is strictly more correct (RFC-4180) — old code would lose whitespace on round-trip. Any conformant CSV reader sees both identically.

---

## 5. ☑ Kill `any` casts in `AgentPanel.tsx:149-162`

Seven `(step.action.params as any).field` casts in a single switch. The discriminated `ActionParamsMap` already exists in `AgentTypes.ts`. Narrowing on `step.action.type` makes all the casts unnecessary.

**Approach**
```ts
switch (step.action.type) {
  case "navigate":
    return `Navigate to ${step.action.params.url || "page"}`;
  case "click":
    return `Click ${step.action.params.selector || "coordinates"}`;
  // …
}
```

Each `case` already narrows `params` to the matching union member — no casts needed. The TS compiler does the work.

**Risk:** none — same runtime behavior, just typed.

---

## 6. ☑ Split `McpAgentRunner.ts` (was 2506 LOC, now 2113)

**Scoped to lift the 15 simple `runTool` wrappers only** — the lowest-risk extraction that still yields meaningful hygiene improvement. Tools that legitimately manipulate runner-private state (screenshot, extractSchema, executeScript, loginRequired, waitForApproval, finish) stayed inline because moving them would have required exposing private fields or designing a broad ToolRuntime interface — out of scope for a pre-submission cleanup.

**What changed**
- Created `src/main/Agent/mcp/tools/simpleTools.ts` (412 LOC of pure declarative tool schemas + a factory that takes a `runTool` callback)
- `ToolResult` type moved there (single source of truth, re-imported by the runner)
- `McpAgentRunner.buildTools()` now spreads `buildSimpleTools(runTool)` then adds the six complex tools inline
- Runner dropped from 2506 → 2113 LOC (−16%)

**Future work for a separate pass** (deliberately deferred):
- Extract `BucketStore` accumulation + `bucketToCsvSection` formatting into its own file
- Design a `ToolRuntime` interface and move the complex tools out too — needs proper exposure of `emitUpdate`, `pushStep`, `nextStepNum`, etc. rather than ad-hoc private-field reach-through.

---

## 7. ☑ Fix `ChatContext.tsx` IPC `any`s

Lines 55, 61, 148, 154 — `(msg: any)` and `(p: any)` across the IPC boundary. Define a `ChatMessagePayload` interface in `preload/sidebar.d.ts` and use it on both sides.

**Risk:** low — type-only change at the boundary.

---

## Out of scope (noted for future)

- `LLMClient.ts` 1208 LOC — has a *third* `buildSystemPrompt` at line 755. Worth splitting (model/key management vs chat history vs summarization), but a separate pass.
- Other `as any` clusters in renderer (`AgentContext.tsx:296`, `BrowserContext.tsx:35`) — leave with their justifying eslint-disable comments unless they bother a reviewer.

---

## Execution order

```
1. Delete dead code         (5 min, zero risk)      ☑ commit e09651e
2. Refresh standards §6     (5 min, zero risk)      ☑ commit e09651e
3. Async I/O                (30 min, low risk)      ☑ commit 30701f1
4. CSV → papaparse          (45 min, medium risk)   ☑ this commit
5. AgentPanel any cleanup   (10 min, zero risk)     ☑
6. McpAgentRunner split     (90 min, medium risk)   ☑ (scoped — simple tools only)
7. ChatContext any cleanup  (15 min, zero risk)     ☑
```

Run `npm run typecheck` after each item. Commit between items.

---

*Maintained by Leif Rydenfalk — ledamecrydenfalk@gmail.com*
