import type { AgentContext, AgentAction } from "../types/AgentTypes";

export function buildReActPrompt(context: AgentContext): string {
  const { goal, history, currentUrl, pageText } = context;

  // Only keep last 5 steps to save tokens
  const recentHistory = history.slice(-5);

  const historyText = recentHistory.length > 0
    ? recentHistory.map((step, i) => {
      const resultStr = step.result.success
        ? `${JSON.stringify(step.result.data).substring(0, 100)}`
        : `Error: ${step.result.error.substring(0, 100)}`;
      return `${i + 1}. ${step.action.type}: ${resultStr}`;
    }).join("\n")
    : "No previous actions.";

  const pageContext = pageText
    ? `\nPage text:\n${pageText.substring(0, 1500)}${pageText.length > 1500 ? "..." : ""}`
    : "";

  return `You are Blueberry AI, a browser automation agent. Be concise and efficient.

Task: ${goal}
URL: ${currentUrl || "unknown"}${pageContext}

Recent actions:
${historyText}

Available actions (JSON only):
- navigate: {"type":"navigate","params":{"url":"..."},"reasoning":"..."}
- click: {"type":"click","params":{"selector":"css-selector"},"reasoning":"..."}
- type: {"type":"type","params":{"selector":"css-selector","text":"...","clearFirst":true},"reasoning":"..."}
- scroll: {"type":"scroll","params":{"direction":"down","amount":500},"reasoning":"..."}
- extract: {"type":"extract","params":{"selector":"css-selector","attribute":"text","name":"key"},"reasoning":"..."}
- finish: {"type":"finish","params":{"answer":"..."},"reasoning":"..."}

CRITICAL RULES:
1. ONE JSON object only. No markdown outside JSON.
2. If extract fails (CSP/security error), use finish and describe what you observed from the page URL and any previous successful extracts.
3. NEVER request screenshot — I automatically capture the page after every action.
4. If stuck after 2 failed actions, use finish with your best answer.
5. Keep reasoning under 80 chars.
6. finish MUST include a helpful answer to the user's goal.

Respond with your next action:`;
}

export function buildSystemPrompt(): string {
  return `You are Blueberry AI, a helpful browser automation agent. You can navigate websites, click elements, type text, scroll, extract information, and take screenshots.
You think step by step and always explain your reasoning before acting. You are careful and precise with selectors. You handle errors gracefully and adapt your strategy.`;
}
