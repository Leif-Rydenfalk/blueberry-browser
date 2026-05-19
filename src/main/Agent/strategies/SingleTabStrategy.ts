import type { Tab } from "../../Tab";
import type { Window } from "../../Window";
import type { LLMClient } from "../../LLMClient";
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

  constructor(window: Window, llmClient: LLMClient) {
    this.window = window;
    this.executor = new ActionExecutor(llmClient);
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
    return {
      success: true,
      data: { tabId: tab.id, url: params.url ?? "about:blank" },
    };
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
    return {
      success: true,
      data: { index: params.index, tabId: target.id, url: target.url },
    };
  }

  private executeCloseTab(params: CloseTabParams): ActionResult {
    const tabs = this.window.allTabs;
    const target =
      params.index !== undefined ? tabs[params.index] : this.activeTab;
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

  // Resolve the visible label of the element targeted by a click/type/key.
  // Used by the HITL approval gate; returning null is safe — the gate falls
  // back to scanning the action's `reasoning` and `params` text.
  async getActionLabel(action: AgentAction): Promise<string | null> {
    const tab = this.activeTab;
    if (!tab) return null;

    if (action.type === "click" || action.type === "type") {
      const params = action.params as {
        selector?: string;
        x?: number;
        y?: number;
        frame?: string;
      };

      if (params.selector) {
        return this.readSelectorLabel(tab, params.selector, params.frame);
      }
      if (
        !params.frame &&
        params.x !== undefined &&
        params.y !== undefined
      ) {
        return this.readPointLabel(tab, params.x, params.y);
      }
    }

    return null;
  }

  private async readSelectorLabel(
    tab: Tab,
    selector: string,
    frame: string | undefined,
  ): Promise<string | null> {
    const frameSetup = frame
      ? `
        var __iframe = document.querySelector(${JSON.stringify(frame)});
        if (!__iframe) return null;
        var __doc = __iframe.contentDocument || (__iframe.contentWindow && __iframe.contentWindow.document);
        if (!__doc) return null;
      `
      : "var __doc = document;";

    const code = `
      (function() {
        try {
          ${frameSetup}
          var el = __doc.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
          var text = (el.innerText || el.textContent || '').trim();
          var name = (el.name || el.id || '');
          var combined = [aria, text, name].filter(Boolean).join(' | ');
          return combined.substring(0, 200);
        } catch (e) {
          return null;
        }
      })()
    `;
    try {
      const result = (await tab.runJs(code)) as string | null;
      return result || null;
    } catch {
      return null;
    }
  }

  private async readPointLabel(
    tab: Tab,
    x: number,
    y: number,
  ): Promise<string | null> {
    const code = `
      (function() {
        try {
          var el = document.elementFromPoint(${x}, ${y});
          if (!el) return null;
          var aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
          var text = (el.innerText || el.textContent || '').trim();
          return [aria, text].filter(Boolean).join(' | ').substring(0, 200);
        } catch (e) {
          return null;
        }
      })()
    `;
    try {
      const result = (await tab.runJs(code)) as string | null;
      return result || null;
    } catch {
      return null;
    }
  }
}
