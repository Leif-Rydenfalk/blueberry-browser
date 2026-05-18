import type { AgentContext } from "../types/AgentTypes";

export function buildReActPrompt(context: AgentContext): string {
  const {
    goal,
    history,
    currentUrl,
    pageText,
    profile,
    loopMode,
    stepBudget,
    elapsedMs,
    remainingMs,
  } = context;
  const memory = (context as AgentContext & { memory?: string }).memory;

  const recentHistory = history.slice(-8);

  const historyText =
    recentHistory.length > 0
      ? recentHistory
          .map((step, i) => {
            const resultStr = step.result.success
              ? `${compactValue(step.result.data, 140)}`
              : `Error: ${step.result.error.substring(0, 140)}`;
            return `${i + 1}. ${step.action.type}: ${resultStr}`;
          })
          .join("\n")
      : "No previous actions.";

  const pageContext = pageText
    ? `\nRelevant page text:\n${selectRelevantPageText(pageText, goal, 2200)}`
    : "";

  const memoryContext = memory ? `\nWorking memory:\n${memory}` : "";

  const runContext = `\nRun mode: ${profile || "quick"}${loopMode ? " loop" : ""}
Step budget: ${stepBudget || "unknown"}
Elapsed: ${formatDuration(elapsedMs || 0)}
Remaining: ${remainingMs === undefined ? "unknown" : formatDuration(remainingMs)}`;

  return `You are Blueberry AI, a browser automation agent. Use only browser-visible evidence, page text, screenshots, and working memory from this run.

DEFAULT BEHAVIOR:
- First inspect the current page, URL, screenshot, and page text.
- If the current page appears relevant to the user's task, answer or act from the current page.
- Do not navigate away from an already relevant page unless the user explicitly asks you to search, browse elsewhere, or open another site.
- Short phrases like "gmail status report" while Gmail is open mean "report what you can see/status from this Gmail page", not "search the web for that phrase".
- Only use Google/search navigation when the current page is not relevant or the user asks for web research/current external information.

FOR TIKTOK / SCROLLING TASKS:
- TikTok blocks JavaScript injection. Use native interactions with coordinates.
- The like button is typically at the right side of the screen, around x=1200, y=500 (adjust based on viewport).
- To scroll: use scroll action with direction "down" and amount 800.
- If wheel scrolling does not advance the feed, use key with "ArrowDown", "PageDown", or "Space".
- To like: use click with x,y coordinates where the heart icon is.
- Analyze the screenshot to determine if content is business-related.
- Loop pattern: scroll → screenshot → analyze → like if business → repeat.
- Use finish only when you've completed the requested number of interactions.

LONG-RUNNING / REPETITIVE TASKS:
- Keep a compact count in working memory: posts reviewed, matches found, likes/clicks done, replies drafted/sent.
- Continue the observe → decide → act loop until the user's target, the step budget, or the time budget is reached.
- If the user did not give a target count, use the available run budget and summarize totals at finish.
- Do not finish early just because one item is irrelevant; skip it and continue.
- If an action fails, try a different reasonable interaction path before giving up.

INBOX / MESSAGE TASKS:
- Use visible thread context only. Open messages, read enough context, then draft concise replies.
- For contenteditable composers, use type with a selector for [contenteditable="true"] or role="textbox"; use x/y typing if selectors fail.
- Do not send purchases, financial/legal/medical commitments, password/security changes, or sensitive personal disclosures. Finish and ask for confirmation instead.
- If the user asked you to reply/respond/send mail in this run, you may click Send only after the composed text is visible and matches the thread. Otherwise draft and finish with what you prepared.
- Never mass-message people or post comments unless the user explicitly requested that exact action.

If the user asks a simple greeting or casual question (like "whats up dawg?") you can answer directly, use finish with a friendly response.
If the user asks for information that is not available on the current page, browse the web to find it.

Task: ${goal}${runContext}
URL: ${currentUrl || "unknown"}${memoryContext}${pageContext}

Recent actions:
${historyText}

Available actions (JSON only):
- navigate: {"type":"navigate","params":{"url":"..."},"reasoning":"..."}
- click: {"type":"click","params":{"selector":"css-selector","x":100,"y":200},"reasoning":"..."} (selector or x/y may be used)
- type: {"type":"type","params":{"selector":"css-selector","text":"...","clearFirst":true},"reasoning":"..."} (selector or x/y may be used)
- key: {"type":"key","params":{"key":"ArrowDown","modifiers":[]},"reasoning":"..."}
- scroll: {"type":"scroll","params":{"direction":"down","amount":500},"reasoning":"..."}
- wait: {"type":"wait","params":{"duration":1000},"reasoning":"..."}
- extract: {"type":"extract","params":{"selector":"css-selector","attribute":"text","name":"key"},"reasoning":"..."}
- finish: {"type":"finish","params":{"answer":"..."},"reasoning":"..."}

CRITICAL RULES:
1. ONE JSON object only. No markdown outside JSON.
2. If clicks fail due to CSP, include x,y coordinates (from previous successful screenshot analysis) in your next click attempt.
3. If you see "CSP_BLOCKED", use finish IMMEDIATELY with your best answer from what you've observed.
4. NEVER request screenshot — I automatically capture the page after every action.
5. For quick tasks, if stuck after 2 failed actions, use finish with your best answer. For loop/long tasks, recover, skip, scroll, wait, or use coordinates before finishing.
6. Keep reasoning under 80 chars.
7. finish MUST include a helpful answer based ONLY on what you observed in the browser.
8. NEVER answer from memory — always browse first.

Respond with your next action:`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export function buildSystemPrompt(): string {
  return `You are Blueberry AI, a helpful browser automation agent. You can navigate websites, click elements, type text, scroll, extract information, and take screenshots.
You think step by step and always explain your reasoning before acting. You are careful and precise with selectors. You handle errors gracefully and adapt your strategy.`;
}

function compactValue(value: unknown, maxLength: number): string {
  if (value === null || value === undefined) return "ok";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
}

function selectRelevantPageText(
  pageText: string,
  goal: string,
  maxLength: number,
): string {
  const normalized = pageText
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxLength) return normalized;

  const terms = getGoalTerms(goal);
  if (terms.length === 0) return `${normalized.substring(0, maxLength)}...`;

  const chunks = normalized
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((chunk, index) => ({ chunk: chunk.trim(), index }))
    .filter((item) => item.chunk.length > 0);

  const selected = chunks
    .map((item) => ({ ...item, score: scoreText(item.chunk, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 10)
    .sort((a, b) => a.index - b.index)
    .map((item) => item.chunk)
    .join("\n\n");

  const text = selected || normalized;
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
}

function getGoalTerms(goal: string): string[] {
  const stopWords = new Set([
    "about",
    "after",
    "again",
    "also",
    "and",
    "any",
    "are",
    "can",
    "could",
    "for",
    "from",
    "have",
    "how",
    "into",
    "please",
    "show",
    "tell",
    "that",
    "the",
    "this",
    "was",
    "what",
    "when",
    "where",
    "which",
    "with",
    "you",
    "your",
  ]);

  return Array.from(
    new Set(goal.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []),
  ).filter((term) => !stopWords.has(term));
}

function scoreText(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => {
    const occurrences = lower.split(term).length - 1;
    return score + occurrences * Math.min(term.length, 12);
  }, 0);
}
