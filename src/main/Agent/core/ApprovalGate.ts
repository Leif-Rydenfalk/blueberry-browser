import type { AgentAction } from "../types/AgentTypes";

// Keywords whose presence on the *target element* or in the agent's *reasoning*
// implies the action is destructive (creates outgoing comms, moves money, or
// makes an irreversible state change). Matching is case-insensitive whole-or-
// substring. Order-insensitive — the first match wins for surfacing in the UI.
//
// Add cautiously: every new keyword expands the surface area that pauses runs
// and can frustrate users with too many prompts. Prefer the strongest signals.
export const DESTRUCTIVE_KEYWORDS: ReadonlyArray<string> = [
  "send",
  "submit",
  "pay",
  "purchase",
  "buy now",
  "checkout",
  "place order",
  "confirm order",
  "confirm purchase",
  "confirm payment",
  "delete",
  "remove",
  "discard",
  "publish",
  "post",
  "tweet",
  "share",
  "approve",
  "transfer",
  "withdraw",
  "deposit",
  "subscribe",
  "unsubscribe",
  "cancel subscription",
  "sign and send",
  "sign contract",
  "accept",
  "agree",
];

export interface RiskAssessment {
  readonly destructive: boolean;
  readonly matchedKeyword?: string;
  // What text we matched on — useful for surfacing context to the user.
  readonly source?: "elementLabel" | "reasoning" | "params" | "explicit";
}

// Pure check: scans the action's `reasoning` field and serialized `params` for
// destructive keywords. Used as a fallback when the strategy can't (or hasn't)
// resolved the element's actual on-page text.
export function classifyActionByText(action: AgentAction): RiskAssessment {
  if (action.type === "waitForApproval") {
    return { destructive: true, source: "explicit" };
  }

  // Only click / type / key warrant a destructive check. Navigation, scroll,
  // extract, finish etc. don't trigger side effects worth gating.
  if (
    action.type !== "click" &&
    action.type !== "type" &&
    action.type !== "key"
  ) {
    return { destructive: false };
  }

  const reasoning = (action.reasoning || "").toLowerCase();
  const reasoningHit = findKeyword(reasoning);
  if (reasoningHit) {
    return {
      destructive: true,
      matchedKeyword: reasoningHit,
      source: "reasoning",
    };
  }

  // Selectors sometimes contain the button label literally (e.g.
  // button[data-action="send-message"]). Scan the param blob as a coarse hint.
  const paramsBlob = safeStringify(action.params).toLowerCase();
  const paramsHit = findKeyword(paramsBlob);
  if (paramsHit) {
    return { destructive: true, matchedKeyword: paramsHit, source: "params" };
  }

  return { destructive: false };
}

// Stronger signal: the actual element label/text from the live page. Use this
// when the strategy can resolve the target.
export function classifyElementLabel(
  action: AgentAction,
  label: string | null,
): RiskAssessment {
  if (action.type === "waitForApproval") {
    return { destructive: true, source: "explicit" };
  }

  if (
    action.type !== "click" &&
    action.type !== "type" &&
    action.type !== "key"
  ) {
    return { destructive: false };
  }

  if (!label) return { destructive: false };

  const hit = findKeyword(label.toLowerCase());
  if (hit) {
    return {
      destructive: true,
      matchedKeyword: hit,
      source: "elementLabel",
    };
  }
  return { destructive: false };
}

function findKeyword(haystack: string): string | undefined {
  for (const keyword of DESTRUCTIVE_KEYWORDS) {
    if (haystack.includes(keyword)) return keyword;
  }
  return undefined;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "click": {
      const p = action.params as {
        selector?: string;
        x?: number;
        y?: number;
      };
      if (p.selector) return `Click \`${p.selector}\``;
      if (p.x !== undefined && p.y !== undefined)
        return `Click at (${p.x}, ${p.y})`;
      return "Click";
    }
    case "type": {
      const p = action.params as { selector?: string; text?: string };
      const text = p.text ? `"${truncate(p.text, 80)}"` : "(no text)";
      return p.selector
        ? `Type ${text} into \`${p.selector}\``
        : `Type ${text}`;
    }
    case "key": {
      const p = action.params as { key?: string };
      return `Press \`${p.key ?? "key"}\``;
    }
    case "waitForApproval":
      return "Awaiting approval";
    default:
      return action.type;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.substring(0, max)}…` : text;
}
