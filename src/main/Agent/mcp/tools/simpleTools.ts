// Tool definitions whose execute() bodies are pure runTool() wrappers — no
// access to runner-private state (no buckets, no manual step emission, no
// HITL gating). These get a clean factory: pass a runTool callback, get back
// a tool map. The complex tools (screenshot, extractSchema, executeScript,
// finish, loginRequired, waitForApproval) stay inline in McpAgentRunner
// because they legitimately need to manipulate runner internals.

import { jsonSchema } from "ai";
import type { AgentAction } from "../../types/AgentTypes";

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
  readonly currentUrl?: string | null;
  readonly pageText?: string | null;
  readonly interactiveElements?: string | null;
}

export type RunToolFn = (action: AgentAction) => Promise<ToolResult>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK tool map requires any
export function buildSimpleTools(runTool: RunToolFn): Record<string, any> {
  return {
    navigate: {
      description:
        "Navigate the browser to a URL. Returns fresh page context (URL, text, elements).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to navigate to" },
        },
        required: ["url"],
      }),
      execute: async ({ url }: { url: string }) =>
        runTool({
          type: "navigate",
          params: { url },
          reasoning: `Navigate to ${url}`,
        }),
    },

    click: {
      description:
        "Click an element by CSS selector or screen coordinates. Prefer selectors from the interactive elements list; use x/y for CSP-blocked pages.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          x: {
            type: "number",
            description: "X coordinate (alternative to selector)",
          },
          y: {
            type: "number",
            description: "Y coordinate (alternative to selector)",
          },
          frame: {
            type: "string",
            description: "CSS selector of iframe to target (optional)",
          },
        },
      }),
      execute: async (params: {
        selector?: string;
        x?: number;
        y?: number;
        frame?: string;
      }) =>
        runTool({
          type: "click",
          params,
          reasoning: `Click ${params.selector ?? `(${params.x},${params.y})`}`,
        }),
    },

    type: {
      description:
        "Type text into an input field or contenteditable element.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of element to type into",
          },
          text: { type: "string", description: "Text to type" },
          clearFirst: {
            type: "boolean",
            description:
              "Clear the field's existing content before typing. DEFAULT TRUE — typing replaces whatever's in the field (an autosaved draft, a placeholder, a prior attempt). Pass false ONLY when you explicitly want to APPEND to existing content (e.g. adding to a long doc, building up a message across multiple type calls).",
          },
          x: {
            type: "number",
            description: "X coordinate (alternative to selector)",
          },
          y: {
            type: "number",
            description: "Y coordinate (alternative to selector)",
          },
          frame: {
            type: "string",
            description: "CSS selector of iframe (optional)",
          },
        },
        required: ["text"],
      }),
      execute: async (params: {
        selector?: string;
        text: string;
        clearFirst?: boolean;
        x?: number;
        y?: number;
        frame?: string;
      }) =>
        runTool({
          type: "type",
          params,
          reasoning: `Type "${params.text.substring(0, 40)}"`,
        }),
    },

    key: {
      description:
        "Send a keyboard key (e.g. Enter, Tab, Escape, ArrowDown).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          key: {
            type: "string",
            description:
              "Key name: Enter, Tab, Escape, ArrowDown, Space, etc.",
          },
          modifiers: {
            type: "array",
            items: {
              type: "string",
              enum: ["control", "shift", "alt", "meta"],
            },
            description: "Modifier keys to hold",
          },
        },
        required: ["key"],
      }),
      execute: async (params: {
        key: string;
        modifiers?: Array<"control" | "shift" | "alt" | "meta">;
      }) => runTool({ type: "key", params, reasoning: `Key ${params.key}` }),
    },

    scroll: {
      description: "Scroll the page up, down, or to a specific element.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "to-element"],
            description: "Scroll direction",
          },
          amount: {
            type: "number",
            description: "Pixels to scroll (default 500)",
          },
          selector: {
            type: "string",
            description: "Scroll to this element (when direction=to-element)",
          },
        },
        required: ["direction"],
      }),
      execute: async (params: {
        direction: "up" | "down" | "to-element";
        amount?: number;
        selector?: string;
      }) =>
        runTool({
          type: "scroll",
          params,
          reasoning: `Scroll ${params.direction}`,
        }),
    },

    wait: {
      description: "Wait for a fixed duration in milliseconds.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          duration: {
            type: "number",
            description: "Wait time in ms (default 1000, max 10000)",
          },
        },
      }),
      execute: async (params: { duration?: number }) =>
        runTool({
          type: "wait",
          params,
          reasoning: `Wait ${params.duration ?? 1000}ms`,
        }),
    },

    waitForSelector: {
      description:
        "Wait until a CSS selector appears in the DOM (useful after navigations or dynamic loads).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector to wait for",
          },
          timeout: {
            type: "number",
            description: "Max wait time in ms (default 10000)",
          },
          visible: {
            type: "boolean",
            description:
              "Also wait for element to be visible (non-zero size)",
          },
        },
        required: ["selector"],
      }),
      execute: async (params: {
        selector: string;
        timeout?: number;
        visible?: boolean;
      }) =>
        runTool({
          type: "waitForSelector",
          params,
          reasoning: `Wait for ${params.selector}`,
        }),
    },

    select: {
      description:
        "Select an option from a <select> dropdown by value or visible text.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector of the <select> element",
          },
          value: {
            type: "string",
            description: "Option value or text to select",
          },
          frame: {
            type: "string",
            description: "CSS selector of iframe (optional)",
          },
        },
        required: ["selector", "value"],
      }),
      execute: async (params: {
        selector: string;
        value: string;
        frame?: string;
      }) =>
        runTool({
          type: "select",
          params,
          reasoning: `Select "${params.value}" in ${params.selector}`,
        }),
    },

    hover: {
      description:
        "Hover over an element (triggers CSS :hover state and tooltips).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector" },
          x: {
            type: "number",
            description: "X coordinate (alternative to selector)",
          },
          y: {
            type: "number",
            description: "Y coordinate (alternative to selector)",
          },
        },
      }),
      execute: async (params: {
        selector?: string;
        x?: number;
        y?: number;
      }) =>
        runTool({
          type: "hover",
          params,
          reasoning: `Hover ${params.selector ?? `(${params.x},${params.y})`}`,
        }),
    },

    back: {
      description: "Navigate back in browser history.",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () =>
        runTool({ type: "back", params: {}, reasoning: "Go back" }),
    },

    forward: {
      description: "Navigate forward in browser history.",
      inputSchema: jsonSchema({ type: "object", properties: {} }),
      execute: async () =>
        runTool({
          type: "forward",
          params: {},
          reasoning: "Go forward",
        }),
    },

    newTab: {
      description: "Open a new browser tab, optionally loading a URL.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to load in the new tab (optional)",
          },
        },
      }),
      execute: async (params: { url?: string }) =>
        runTool({
          type: "newTab",
          params,
          reasoning: `New tab${params.url ? ` → ${params.url}` : ""}`,
        }),
    },

    switchTab: {
      description: "Switch to a different open tab by index (0-based).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          index: { type: "number", description: "Tab index (0 = first tab)" },
        },
        required: ["index"],
      }),
      execute: async (params: { index: number }) =>
        runTool({
          type: "switchTab",
          params,
          reasoning: `Switch to tab ${params.index}`,
        }),
    },

    closeTab: {
      description: "Close a tab by index (default: active tab).",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          index: {
            type: "number",
            description: "Tab index to close (default: active)",
          },
        },
      }),
      execute: async (params: { index?: number }) =>
        runTool({
          type: "closeTab",
          params,
          reasoning: `Close tab ${params.index ?? "active"}`,
        }),
    },

    extract: {
      description:
        "Extract text, HTML, or attribute value from elements matching a CSS selector.",
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          selector: {
            type: "string",
            description: "CSS selector for target elements",
          },
          attribute: {
            type: "string",
            enum: ["text", "html", "value"],
            description:
              'What to extract: "text" (default), "html", or "value"',
          },
          name: {
            type: "string",
            description: "Key name for the extracted data in the result",
          },
          frame: {
            type: "string",
            description: "CSS selector of iframe (optional)",
          },
        },
        required: ["selector", "name"],
      }),
      execute: async (params: {
        selector: string;
        attribute?: "text" | "html" | "value";
        name: string;
        frame?: string;
      }) =>
        runTool({
          type: "extract",
          params,
          reasoning: `Extract ${params.name} from ${params.selector}`,
        }),
    },
  };
}
