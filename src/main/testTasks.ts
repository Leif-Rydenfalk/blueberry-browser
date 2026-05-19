/**
 * Agent test task definitions.
 * Each task is a real goal given to McpAgentRunner against a live browser.
 * Validators inspect the agent's final answer — keep them forgiving since
 * page layouts change and LLM responses vary.
 */

export interface TestTask {
  readonly name: string;
  readonly goal: string;
  readonly timeoutMs: number;
  readonly validate?: (answer: string, steps: number) => TestValidation;
  /** Skip navigating to a fresh about:blank before starting */
  readonly keepCurrentPage?: boolean;
}

export interface TestValidation {
  readonly pass: boolean;
  readonly reason: string;
}

function contains(text: string, ...keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export const TEST_TASKS: readonly TestTask[] = [
  // ─── Navigation & basic extraction ───────────────────────────────────────────

  {
    name: "navigate-example-com",
    goal: "Navigate to https://example.com and tell me the main heading text on the page.",
    timeoutMs: 30_000,
    validate: (answer) => ({
      pass: contains(answer, "example domain", "example", "illustrative"),
      reason: "Answer should mention 'Example Domain'",
    }),
  },

  {
    name: "quotes-scrape-basic",
    goal: "Go to https://quotes.toscrape.com and extract the first 5 quotes on the page using extractSchema. Return them as a table with author and text columns.",
    timeoutMs: 90_000,
    validate: (answer, steps) => {
      const hasData = contains(answer, "einstein", "by", "oscar", "wilde", "eleanor") ||
        answer.includes("author") || answer.includes("quote") || answer.includes("text");
      return {
        pass: hasData && steps >= 2,
        reason: "Should extract real quote data and use at least 2 steps",
      };
    },
  },

  {
    name: "books-toscrape-prices",
    goal: "Go to https://books.toscrape.com and extract the titles and prices of the first 10 books using extractSchema. Return them with title and price columns.",
    timeoutMs: 120_000,
    validate: (answer, steps) => {
      const hasBooks = contains(answer, "light", "price", "£", "pound", "book") ||
        answer.includes("title") || answer.includes("Pound");
      return {
        pass: hasBooks && steps >= 2,
        reason: "Should extract book titles and prices",
      };
    },
  },

  // ─── Multi-step reasoning ─────────────────────────────────────────────────────

  {
    name: "wikipedia-extract",
    goal: "Go to https://en.wikipedia.org/wiki/Electron and tell me: what year was Electron (the framework) first released, and who developed it? Look for this in the page.",
    timeoutMs: 60_000,
    validate: (answer) => ({
      pass: contains(answer, "2013", "2014", "2015", "github", "atom", "cheng"),
      reason: "Should mention the release year and GitHub/Atom connection",
    }),
  },

  {
    name: "hn-frontpage",
    goal: "Go to https://news.ycombinator.com and extract the titles of the top 10 posts on the front page using extractSchema with columns: rank, title, points.",
    timeoutMs: 90_000,
    validate: (answer, steps) => {
      const hasContent = answer.length > 100 && steps >= 2;
      return {
        pass: hasContent,
        reason: "Should extract HN post titles (any 10 visible posts)",
      };
    },
  },

  // ─── Scroll and pagination ────────────────────────────────────────────────────

  {
    name: "quotes-page2",
    goal: "Go to https://quotes.toscrape.com, extract quotes from page 1 (with author), then navigate to page 2 and extract quotes from there too. Tell me the total count and list all authors you found.",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: steps >= 4 && answer.length > 80,
      reason: "Should navigate to page 2 and collect quotes from both pages",
    }),
  },

  // ─── Screenshot reasoning ─────────────────────────────────────────────────────

  {
    name: "screenshot-test",
    goal: "Go to https://example.com, take a screenshot to verify what you see, then describe what the page looks like visually.",
    timeoutMs: 45_000,
    validate: (answer) => ({
      pass: contains(answer, "white", "text", "heading", "example", "simple", "clean", "page"),
      reason: "Should describe the example.com page appearance",
    }),
  },

  // ─── Error recovery ────────────────────────────────────────────────────────────

  {
    name: "non-existent-page",
    goal: "Try to navigate to https://this-domain-does-not-exist-blueberry-test-12345.com and tell me what happened.",
    timeoutMs: 30_000,
    validate: (answer) => ({
      pass: contains(answer, "error", "fail", "could not", "unable", "not found", "dns", "refused", "unreachable"),
      reason: "Should report that the page could not be loaded",
    }),
  },

  // ─── Data aggregation ─────────────────────────────────────────────────────────

  {
    name: "github-trending-extract",
    goal: "Go to https://github.com/trending and extract the top 10 trending repositories using extractSchema. Include columns: repo_name, language, stars. Return as a table.",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: steps >= 2 && answer.length > 100,
      reason: "Should extract trending repo data from GitHub",
    }),
  },

  // ─── Quick conversational finish ─────────────────────────────────────────────

  {
    name: "trivial-greeting",
    goal: "What's the capital of France? Answer directly without browsing.",
    timeoutMs: 15_000,
    validate: (answer) => ({
      pass: contains(answer, "paris"),
      reason: "Should answer Paris",
    }),
  },
];
