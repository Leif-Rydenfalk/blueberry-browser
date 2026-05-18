import type { Tab } from "../../Tab";
import type { Window } from "../../Window";
import type {
  TabStrategy,
  AgentAction,
  ActionResult,
  AgentContext,
  TabInfo,
  NewTabParams,
  SwitchTabParams,
  CloseTabParams,
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
    history: ReadonlyArray<import("../types/AgentTypes").AgentStep>,
  ): Promise<AgentContext> {
    const [pageText, currentUrl, interactiveElements] = await Promise.all([
      this.getPageText(),
      this.getCurrentUrl(),
      this.getInteractiveElements(),
    ]);

    return {
      goal,
      history,
      currentUrl,
      pageText,
      screenshot: null,
      interactiveElements,
      tabs: this.getTabsInfo(),
    };
  }

  async executeAction(action: AgentAction): Promise<ActionResult> {
    if (action.type === "newTab") {
      return this.executeNewTab(action.params as NewTabParams);
    }
    if (action.type === "switchTab") {
      return this.executeSwitchTab(action.params as SwitchTabParams);
    }
    if (action.type === "closeTab") {
      return this.executeCloseTab(action.params as CloseTabParams);
    }
    return this.executor.execute(this.activeTab, action);
  }

  private async executeNewTab(params: NewTabParams): Promise<ActionResult> {
    const tab = this.window.createTab(params.url);
    this.window.switchActiveTab(tab.id);
    if (params.url) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
    return { success: true, data: { tabId: tab.id, url: params.url ?? "about:blank" } };
  }

  private executeSwitchTab(params: SwitchTabParams): ActionResult {
    const tabs = this.window.allTabs;
    const target = tabs[params.index];
    if (!target) {
      return {
        success: false,
        error: `No tab at index ${params.index}. There are ${tabs.length} tab(s).`,
        recoverable: true,
      };
    }
    this.window.switchActiveTab(target.id);
    return { success: true, data: { index: params.index, tabId: target.id, url: target.url } };
  }

  private executeCloseTab(params: CloseTabParams): ActionResult {
    const tabs = this.window.allTabs;
    const target = params.index !== undefined ? tabs[params.index] : this.activeTab;
    if (!target) {
      return {
        success: false,
        error: `No tab at index ${params.index ?? "active"}.`,
        recoverable: true,
      };
    }
    this.window.closeTab(target.id);
    return { success: true, data: { closedTabId: target.id } };
  }

  private getTabsInfo(): ReadonlyArray<TabInfo> {
    const activeId = this.activeTab?.id;
    return this.window.allTabs.map((tab, index) => ({
      id: tab.id,
      index,
      title: tab.title,
      url: tab.url,
      isActive: tab.id === activeId,
    }));
  }

  private async getInteractiveElements(): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;
    try {
      return await tab.getInteractiveElements();
    } catch {
      return null;
    }
  }

  async captureScreenshot(maxWidth = 800): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;
    try {
      const image = await tab.screenshot({ maxWidth });
      return image.toDataURL();
    } catch (error) {
      console.error("[SingleTabStrategy] Screenshot failed:", error);
      return null;
    }
  }

  async getPageText(): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;

    // Try CDP method first (bypasses CSP)
    try {
      const cdpText = await tab.getTextViaCDP();
      if (cdpText && cdpText.length > 0) {
        return cdpText;
      }
    } catch {
      console.log("[SingleTabStrategy] CDP failed, trying other methods...");
    }

    // Try standard method
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
