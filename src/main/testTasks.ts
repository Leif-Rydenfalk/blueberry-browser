/**
 * Agent test task definitions.
 * Each task is a real goal given to McpAgentRunner against a live browser.
 * Validators inspect the agent's final answer — keep them forgiving since
 * page layouts change and LLM responses vary.
 *
 * Design principle: tasks should reflect genuinely useful real-world workflows.
 * When a test fails, improve the agent — do not simplify the test.
 *
 * Run: pnpm test                 (all tasks)
 *       pnpm test --filter=name   (one task by name substring)
 *       pnpm test:visible         (same, window visible for debugging)
 */

export interface TestTask {
  readonly name: string;
  readonly goal: string;
  readonly timeoutMs: number;
  readonly validate?: (answer: string, steps: number) => TestValidation;
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
  // ─── Tier 1: Smoke tests ────────────────────────────────────────────────────

  {
    name: "trivial-greeting",
    goal: "What's the capital of France? Answer directly without browsing.",
    timeoutMs: 15_000,
    validate: (answer) => ({
      pass: contains(answer, "paris"),
      reason: "Should answer Paris",
    }),
  },

  {
    name: "navigate-and-extract",
    goal: "Navigate to https://example.com and tell me the main heading text and the two linked pages or domains mentioned in the body text.",
    timeoutMs: 30_000,
    validate: (answer) => ({
      pass: contains(answer, "example domain", "example") && contains(answer, "iana", "example"),
      reason: "Should extract heading and mention IANA/example.org from the page",
    }),
  },

  {
    name: "error-recovery",
    goal: "Try to navigate to https://this-domain-does-not-exist-blueberry-test-12345.com, describe what error you got, then recover by navigating to https://example.com instead and tell me the page title.",
    timeoutMs: 60_000,
    validate: (answer) => ({
      pass: contains(answer, "error", "dns", "fail", "not found", "unable") &&
            contains(answer, "example", "domain", "recover"),
      reason: "Should report the DNS error AND successfully recover to example.com",
    }),
  },

  {
    name: "screenshot-visual-analysis",
    goal: "Go to https://the-internet.herokuapp.com/hovers, take a screenshot of the page, then hover over the first photo and take another screenshot. Describe what changed visually between the two screenshots.",
    timeoutMs: 150_000,
    validate: (answer, steps) => ({
      pass: answer.length > 100 && steps >= 3 &&
            contains(answer, "hover", "appear", "name", "photo", "user", "profile", "link"),
      reason: "Should compare before/after hover screenshots and describe the tooltip/overlay that appeared",
    }),
  },

  // ─── Tier 2: Structured data extraction ──────────────────────────────────────

  {
    name: "npm-package-research",
    goal: "Go to https://www.npmjs.com/package/electron and extract: the current version, weekly download count, description, and list of maintainers. This is real developer research.",
    timeoutMs: 90_000,
    validate: (answer) => ({
      pass: contains(answer, "electron", "version", "download", "maintainer", "description") && answer.length > 100,
      reason: "Should report npm package details: version, downloads, description, maintainers",
    }),
  },

  {
    name: "hn-frontpage-analysis",
    goal: "Go to https://news.ycombinator.com and extract the top 15 posts using extractSchema (columns: rank, title, points, domain). Then analyze: what domains appear most often, and what are the top 3 posts by points?",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: answer.length > 150 && steps >= 3 && contains(answer, "point", "domain", "title"),
      reason: "Should extract 15 HN posts and analyze domain distribution + top posts",
    }),
  },

  {
    name: "github-trending-analysis",
    goal: "Go to https://github.com/trending and extract all visible repos using extractSchema (columns: repo_name, description, language, stars_today). Analyze which programming language dominates today's trending and name the top 3 repos.",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: answer.length > 150 && steps >= 3 && contains(answer, "star", "language", "repo", "trending"),
      reason: "Should extract trending repos and analyze language distribution",
    }),
  },

  // ─── Tier 3: Web app testing & interaction ────────────────────────────────────

  {
    name: "todomvc-workflow",
    goal: "Go to https://todomvc.com/examples/react/dist/ and test the TodoMVC app like a QA engineer: add 3 todos ('Buy groceries', 'Write code', 'Go for a run'), mark 'Buy groceries' as complete, then filter to show only Active todos. Report the app state at each step and confirm the final list shows only the 2 active items.",
    timeoutMs: 180_000,
    validate: (answer, steps) => {
      const hasWorkflow = contains(answer, "groceries", "code", "run", "complete", "active", "filter");
      return {
        pass: hasWorkflow && steps >= 6,
        reason: "Should add todos, complete one, filter to active, and report correct state",
      };
    },
  },

  {
    name: "internet-full-form",
    goal: "Go to https://the-internet.herokuapp.com/login, log in with username 'tomsmith' and password 'SuperSecretPassword!', then on the secure page, click the logout button and confirm you are logged out. Report each step.",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: contains(answer, "logged in", "secure", "logged out", "login") && steps >= 4,
      reason: "Should complete the full login + logout cycle",
    }),
  },

  {
    name: "drag-and-drop-or-dynamic",
    goal: "Go to https://the-internet.herokuapp.com/dynamic_content and reload the page 2 times using the link at the top that says 'click here'. Each time, extract the content of the first dynamic text block using extractSchema. Report how the content changed across the 3 loads.",
    timeoutMs: 180_000,
    validate: (answer, steps) => ({
      pass: answer.length > 100 && steps >= 5,
      reason: "Should observe dynamic content changing across page reloads",
    }),
  },

  // ─── Tier 4: Multi-source research workflows ─────────────────────────────────

  {
    name: "electron-version-research",
    goal: "Research the latest Electron.js release: go to https://github.com/electron/electron/releases and find the most recent stable release version and its release date. Then go to https://www.electronjs.org/docs/latest/tutorial/quick-start and verify the 'Getting Started' docs mention this version (or a compatible one). Report your findings.",
    timeoutMs: 300_000,
    validate: (answer, steps) => ({
      pass: answer.length > 150 && steps >= 4 &&
            contains(answer, "release", "version", "electron", "stable"),
      reason: "Should research Electron release version across github and docs",
    }),
  },

  {
    name: "tech-comparison-research",
    goal: "Compare Bun and Node.js as JavaScript runtimes. Go to https://bun.sh and extract their key performance claims and features. Then go to https://nodejs.org/en and note the current LTS version and any major selling points. Report a brief comparison of both runtimes.",
    timeoutMs: 180_000,
    validate: (answer, steps) => ({
      pass: answer.length > 200 && steps >= 4 &&
            contains(answer, "bun", "node", "javascript", "runtime", "performance", "version"),
      reason: "Should visit both sites and produce a comparison with specific data from each",
    }),
  },

  {
    name: "wikipedia-topic-exploration",
    goal: "Start at https://en.wikipedia.org/wiki/TypeScript, find 2 key technical facts about TypeScript (e.g., when it was created, who made it). Then follow the link to the section about its relationship to JavaScript or to the Anders Hejlsberg article, and report one additional fact you found on the second page.",
    timeoutMs: 120_000,
    validate: (answer, steps) => ({
      pass: answer.length > 100 && steps >= 3 &&
            contains(answer, "typescript", "microsoft", "2012", "anders", "hejlsberg", "javascript"),
      reason: "Should extract TypeScript facts and follow at least one link for additional info",
    }),
  },

  // ─── Tier 5: Agentic data pipelines ──────────────────────────────────────────

  {
    name: "multi-page-job-listings",
    goal: "Go to https://news.ycombinator.com/jobs and extract job listings using extractSchema (columns: title, company, location). Collect at least 10 listings. If there's a 'More' or next-page link, follow it and collect from page 2 as well. Report total collected and list the companies.",
    timeoutMs: 240_000,
    validate: (answer, steps) => ({
      pass: answer.length > 150 && steps >= 4 && contains(answer, "job", "company", "listing"),
      reason: "Should extract HN job listings across 1-2 pages",
    }),
  },

  {
    name: "github-issue-triage",
    goal: "Go to https://github.com/microsoft/vscode/issues?q=is:open+is:issue+label:bug+sort:reactions-desc and extract the top 8 most-reacted open bugs using extractSchema (columns: title, reactions, url). Report which bugs have the most community support and what they are about.",
    timeoutMs: 180_000,
    validate: (answer, steps) => ({
      pass: answer.length > 150 && steps >= 3 && contains(answer, "bug", "issue", "reaction", "vscode"),
      reason: "Should extract top VSCode bugs by reaction count and summarize their themes",
    }),
  },

  {
    name: "packages-changelog-research",
    goal: "Go to https://github.com/vitejs/vite/releases and extract the last 5 Vite releases using extractSchema (columns: version, date, key_changes_summary — summarize from the release notes). Report the version history and highlight any major breaking changes.",
    timeoutMs: 360_000,
    validate: (answer, steps) => ({
      pass: answer.length > 200 && steps >= 3 &&
            contains(answer, "vite", "release", "version", "change"),
      reason: "Should extract Vite release history with version numbers and highlight changes",
    }),
  },

  // ─── Tier 6: Creative agent workflows ────────────────────────────────────────

  {
    name: "tech-news-digest",
    goal: "Create a tech news digest. Go to https://news.ycombinator.com, extract the top 10 posts using extractSchema. Group them by topic (AI/ML, security, tools, web dev, other). For each group, list the posts. Output a formatted digest with sections.",
    timeoutMs: 180_000,
    validate: (answer, steps) => ({
      pass: answer.length > 300 && steps >= 3 &&
            contains(answer, "title", "point", "group", "topic", "digest"),
      reason: "Should extract and categorize HN posts into a formatted digest",
    }),
  },

  {
    name: "open-source-discovery",
    goal: "You're a developer scouting for interesting open-source projects. Go to https://github.com/explore and find projects tagged with 'beginner-friendly' or look at the Explore page. Extract at least 5 interesting repos with their name, description, and star count. Give a recommendation on which one to contribute to first and why.",
    timeoutMs: 180_000,
    validate: (answer, steps) => ({
      pass: answer.length > 200 && steps >= 3 &&
            contains(answer, "github", "star", "project", "repo", "open source"),
      reason: "Should discover open source projects and give a recommendation",
    }),
  },
];
