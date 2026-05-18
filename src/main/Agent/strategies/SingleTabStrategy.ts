import type { Tab } from "../../Tab";
import type { Window } from "../../Window";
import type {
  TabStrategy,
  AgentAction,
  ActionResult,
  AgentContext,
} from "../types/AgentTypes";
import { ActionExecutor } from "../core/ActionExecutor";

export class SingleTabStrategy implements TabStrategy {
  readonly name = "single-tab";
  private window: Window;
  private executor: ActionExecutor;

  constructor(window: Window) {
    this.window = window;
    this.executor = new ActionExecutor();
  }

  private get activeTab(): Tab | null {
    return this.window.activeTab;
  }

  async getActiveContext(
    goal: string,
    history: ReadonlyArray<import("../types/AgentTypes").AgentStep>
  ): Promise<AgentContext> {
    const [screenshot, pageText, currentUrl] = await Promise.all([
      this.captureScreenshot(),
      this.getPageText(),
      this.getCurrentUrl(),
    ]);

    return {
      goal,
      history,
      currentUrl,
      pageText,
      screenshot,
    };
  }

  async executeAction(action: AgentAction): Promise<ActionResult> {
    return this.executor.execute(this.activeTab, action);
  }

  async captureScreenshot(): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;
    try {
      const image = await tab.screenshot();
      return image.toDataURL();
    } catch (error) {
      console.error("[SingleTabStrategy] Screenshot failed:", error);
      return null;
    }
  }

  async getPageText(): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;
    try {
      return await tab.getTabText();
    } catch (error) {
      console.error("[SingleTabStrategy] Get page text failed:", error);
      return null;
    }
  }

  async getCurrentUrl(): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;
    return tab.url;
  }
}