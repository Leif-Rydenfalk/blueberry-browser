# Blueberry Browser — Test Suite

The agent test suite runs McpAgentRunner against real websites using a live Electron browser and real LLM calls. **No mocks, no stubs — everything hits the real browser and the real LLM API.**

---

## How to run

```bash
# 1. Always build before running tests
npx electron-vite build

# 2. Run all tasks (window hidden, cheapest model)
LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-4-6 npx electron out/main/index.js --test

# Or via pnpm (builds + runs, model baked into package.json):
pnpm test

# Show the browser window while running (good for debugging):
pnpm test:visible

# Run only tasks matching a name substring:
LLM_PROVIDER=anthropic LLM_MODEL=claude-sonnet-4-6 npx electron out/main/index.js --test --filter=todomvc
```

## Model selection

Use the cheapest capable model for tests — if a task passes with sonnet-4-6, it will pass even better with opus:

```bash
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-4-6   # default for tests
```

Override at runtime without changing `.env`:
```bash
LLM_PROVIDER=anthropic LLM_MODEL=claude-opus-4-7 npx electron out/main/index.js --test
```

## Prerequisite

Electron requires an X display. On this machine `$DISPLAY=:1` is pre-configured (virtual framebuffer). If you see GPU or display errors, the X server has stopped — restart it.

---

## Output format

```
🫐 Blueberry Agent Test Suite  18 tasks
────────────────────────────────────────────────────────────

▶ todomvc-workflow (180s budget)
  → navigate(url=https://todomvc.com/examples/react/dist/)
  ✓ 1842ms {"url":"https://todomvc.com/examples/react/dist/"}
  → click(selector=#todo-input)
  ✓ 12ms
  → type(selector=#todo-input, text=Buy groceries)
  ✓ 8ms
  …
  ✓ 12500ms {"completed":true,"answer":"# ✅ TodoMVC QA Test Report…"}
  PASS 149.8s 15 steps
  answer: # ✅ TodoMVC QA Test Report — React App...

▶ electron-version-research (300s budget)
  FAIL 300.1s 16 steps — Should research Electron release version...
```

- `▶ name (Ns budget)` — task starting, wall-clock budget shown
- `→ tool(params)` — agent calling a tool
- `✓ Nms result` — tool completed successfully
- `✗ Nms error: ...` — tool failed (agent will retry or recover)
- `⚡ Auto-approving...` — HITL gate triggered (test mode auto-approves)
- `PASS / FAIL` — validator result + timing + step count
- `answer: ...` — first 200 chars of the agent's final answer

Reports are also written as JSON to `~/.config/Electron/test-reports/report-<timestamp>.json` with full step logs.

---

## Task catalogue

Tasks are defined in `src/main/testTasks.ts` and grouped by complexity tier.

| Tier | Focus | Tasks |
|------|-------|-------|
| 1 — Smoke | Basic agent boot, navigation, error handling | `trivial-greeting`, `navigate-and-extract`, `error-recovery`, `screenshot-visual-analysis` |
| 2 — Extraction | extractSchema, real data scraping | `npm-package-research`, `hn-frontpage-analysis`, `github-trending-analysis` |
| 3 — Web app testing | Form fill, login/logout, dynamic content | `todomvc-workflow`, `internet-full-form`, `drag-and-drop-or-dynamic` |
| 4 — Multi-site research | Navigate 2+ domains, cross-reference | `electron-version-research`, `tech-comparison-research`, `wikipedia-topic-exploration` |
| 5 — Data pipelines | Pagination, multi-page aggregation, issue triage | `multi-page-job-listings`, `github-issue-triage`, `packages-changelog-research` |
| 6 — Creative agentic | Synthesis, categorization, recommendation | `tech-news-digest`, `open-source-discovery` |

---

## Adding a new task

Edit `src/main/testTasks.ts`:

```typescript
{
  name: "kebab-case-name",            // used with --filter=
  goal: "Natural language goal for the agent. Be specific about what to do and what to report.",
  timeoutMs: 120_000,                 // wall-clock budget — set 30-50% above expected duration
  validate: (answer, steps) => ({
    pass: contains(answer, "keyword1", "keyword2") && steps >= 3,
    reason: "Shown in FAIL output — describe what the agent should have done",
  }),
}
```

**Validator rules:**
- `contains(text, ...keywords)` is case-insensitive OR across all keywords
- Always check `steps >= N` to prove the agent did real work, not a hallucination
- Use `answer.length > N` as a broad content sanity check
- Keep validators forgiving — websites change layout, LLM phrasing varies
- For tasks that research live data (prices, versions, scores), check structure not exact values

**Task design principles:**
- Tasks should reflect real useful workflows, not toy demos
- If a task fails, fix the agent — do not simplify the task
- After adding a task, run it alone first: `--filter=task-name`
- Then verify it passes in the full suite (API rate limiting can cause timeouts)

---

## How the harness works (for AI agents reading this)

```
TestHarness
  ├─ reads TEST_TASKS array from testTasks.ts
  ├─ for each task:
  │   ├─ navigates active tab to about:blank (fresh state)
  │   ├─ creates a new AgentOrchestrator
  │   ├─ sets AUTO-APPROVE callbacks for HITL gates (no human present in test mode)
  │   ├─ starts the session with task.goal
  │   ├─ races against a timeout that calls orchestrator.abortSession()
  │   └─ runs task.validate(answer, steps) → TestValidation
  └─ prints summary, writes JSON report, exits with code 1 if any failed
```

**Key implementation files:**
- `src/main/TestHarness.ts` — test runner, output, JSON reports
- `src/main/testTasks.ts` — task definitions and validators
- `src/main/Agent/mcp/McpAgentRunner.ts` — the agent loop being tested
- `src/main/Agent/strategies/SingleTabStrategy.ts` — browser interaction layer

**HITL (human-in-the-loop) in test mode:**
The test harness auto-approves all approval requests and script reviews via:
```typescript
orchestrator.setApprovalCallback(req => orchestrator.resolveApproval(req.id, "approve-all"));
orchestrator.setScriptReviewCallback(req => orchestrator.resolveScriptReview(req.id, { decision: "approve" }));
```
This lets `executeScript` and `waitForApproval` flows run end-to-end without blocking.

---

## When a test fails

**Do not simplify the test. Fix the agent.**

Diagnose in this order:

1. **Timeout** — the agent ran out of budget. Check if the issue is API latency in the full suite (run the test alone — if it passes alone, increase `timeoutMs`).

2. **Validator keyword mismatch** — the agent answered but with different words. Check the actual answer (shown after FAIL), adjust keywords if the answer is substantively correct.

3. **Step count too low** — `steps >= N` failed. The agent skipped real work or hallucinated. Look at what the agent did in the step log.

4. **Agent stuck in a loop** — many steps but no progress. Usually a scraper failure or a page that needs scroll/pagination. Improve the system prompt or add guidance in the goal.

5. **Screenshot hanging** — `captureScreenshot` has an 8s race timeout. If screenshots still hang, check the display.

6. **LLM didn't call finish** — answer is `"Reached the step budget after N steps."` This means `generateText` ended without the agent calling the `finish` tool. The system prompt now mandates this — if it recurs, check the prompt in `McpAgentRunner.buildSystemPrompt()`.

---

## Known limitations

- Screenshots are empty in some headless configs (`Current display surface not available`). The 8s timeout in `SingleTabStrategy.captureScreenshot` prevents hanging.
- `getPageText` fails on `about:blank` — expected, logged, harmless.
- Tests run sequentially. API rate limits can cause the 4th–6th consecutive LLM call to be slower than when run in isolation — add extra budget (30-50%) for tasks later in the suite.
- Tasks that require real-time data (stock prices, live news) will have different results every run — validators use structural checks, not exact values.
