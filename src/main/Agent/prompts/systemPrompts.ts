import type { AgentContext, AgentAction } from "../types/AgentTypes";

export function buildReActPrompt(context: AgentContext): string {
  const { goal, history, currentUrl, pageText } = context;
  const historyText = history.length > 0
    ? history.map((step, i) => {
      const resultStr = step.result.success
        ? `Success: ${JSON.stringify(step.result.data).substring(0, 200)}`
        : `Error: ${step.result.error}`;
      return `Step ${i + 1}:\nAction: ${JSON.stringify(step.action)}\nResult: ${resultStr}`;
    }).join("\\n\\n")
    : "No previous actions taken.";
  // Much shorter page context - only first 1500 chars
  const pageContext = pageText
    ? `\nPage text:\n${pageText.substring(0, 1500)}${pageText.length > 1500 ? "..." : ""}`
    : "";
  return `You are a browser automation agent called Blueberry AI. You control a web browser to achieve user goals.
Your task: ${goal}
Current page URL: ${currentUrl || "unknown"}${pageContext}
Previous actions:
${historyText}
Available actions (respond with JSON only):
- navigate: { "type": "navigate", "params": { "url": "..." }, "reasoning": "..." }
- click: { "type": "click", "params": { "selector": "css-selector" }, "reasoning": "..." }
- type: { "type": "type", "params": { "selector": "css-selector", "text": "...", "clearFirst": true }, "reasoning": "..." }
- scroll: { "type": "scroll", "params": { "direction": "down", "amount": 500 }, "reasoning": "..." }
- extract: { "type": "extract", "params": { "selector": "css-selector", "attribute": "text", "name": "resultName" }, "reasoning": "..." }
- screenshot: { "type": "screenshot", "params": {}, "reasoning": "Need to see current state" }
- finish: { "type": "finish", "params": { "answer": "..." }, "reasoning": "Task is complete" }
CRITICAL RULES:
1. Respond with EXACTLY ONE valid JSON object. No markdown, no explanation outside JSON.
2. Use CSS selectors that are specific and stable. Prefer IDs and data attributes.
3. If you need to see the page, use screenshot first.
4. If an action fails, try a different approach — maybe scroll to find the element.
5. When typing in search boxes, always submit the form or press Enter after typing.
6. Extract information only when you have found what the user is looking for.
7. The finish action should include a concise answer to the user's goal.
Respond now with your next action:`;
}

export function buildSystemPrompt(): string {
  return `You are Blueberry AI, a helpful browser automation agent. You can navigate websites, click elements, type text, scroll, extract information, and take screenshots.
You think step by step and always explain your reasoning before acting. You are careful and precise with selectors. You handle errors gracefully and adapt your strategy.`;
}
