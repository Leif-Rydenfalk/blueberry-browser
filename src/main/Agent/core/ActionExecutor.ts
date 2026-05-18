import type { Tab } from "../../Tab";
import type {
  AgentAction,
  ActionResult,
  ActionType,
} from "../types/AgentTypes";

export class ActionExecutor {
  async execute(tab: Tab | null, action: AgentAction): Promise<ActionResult> {
    if (!tab) {
      return {
        success: false,
        error: "No active tab available",
        recoverable: false,
      };
    }

    try {
      switch (action.type) {
        case "navigate":
          return await this.executeNavigate(tab, action.params as { url: string });
        case "click":
          return await this.executeClick(tab, action.params as { selector: string; x?: number; y?: number });
        case "type":
          return await this.executeType(tab, action.params as { selector: string; text: string; clearFirst?: boolean });
        case "scroll":
          return await this.executeScroll(tab, action.params as { direction: string; amount?: number; selector?: string });
        case "wait":
          return await this.executeWait(action.params as { duration?: number });
        case "extract":
          return await this.executeExtract(tab, action.params as { selector: string; attribute?: string; name: string });
        case "screenshot":
          const image = await tab.screenshot();
          return { success: true, data: { screenshot: image.toDataURL() } };
        case "finish":
          return { success: true, data: { completed: true, answer: (action.params as { answer?: string }).answer } };
        default:
          return {
            success: false,
            error: `Unknown action type: ${(action as any).type}`,
            recoverable: true,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[ActionExecutor] ${action.type} failed:`, message);
      return {
        success: false,
        error: message,
        recoverable: this.isRecoverable(action.type, message),
      };
    }
  }

  private async executeNavigate(tab: Tab, params: { url: string }): Promise<ActionResult> {
    await tab.loadURL(params.url);
    await this.sleep(2000);
    return { success: true, data: { url: params.url } };
  }

  private async executeClick(tab: Tab, params: { selector: string; x?: number; y?: number }): Promise<ActionResult> {
    const code = `
      (function() {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { error: "Element not found: ${params.selector.replace(/"/g, '\\"')}" };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const rect = el.getBoundingClientRect();
        const clickEvent = new MouseEvent('click', {
          bubbles: true, cancelable: true, view: window,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2
        });
        el.dispatchEvent(clickEvent);
        return { success: true, tagName: el.tagName, text: el.textContent?.substring(0, 100) };
      })()
    `;
    const result = await tab.runJs(code);
    if (result && result.error) {
      return { success: false, error: result.error, recoverable: true };
    }
    await this.sleep(500);
    return { success: true, data: result };
  }

  private async executeType(tab: Tab, params: { selector: string; text: string; clearFirst?: boolean }): Promise<ActionResult> {
    const code = `
      (function() {
        const el = document.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { error: "Element not found: ${params.selector.replace(/"/g, '\\"')}" };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        if (${params.clearFirst ?? false} && el.value) {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const text = ${JSON.stringify(params.text)};
        for (let i = 0; i < text.length; i++) {
          const char = text[i];
          el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
          if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.value += char;
          }
          el.dispatchEvent(new InputEvent('input', { data: char, bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
        }
        if (el.tagName === 'INPUT' && el.type === 'search') {
          el.form?.dispatchEvent(new Event('submit', { bubbles: true }));
        }
        return { success: true, value: el.value };
      })()
    `;
    const result = await tab.runJs(code);
    if (result && result.error) {
      return { success: false, error: result.error, recoverable: true };
    }
    await this.sleep(500);
    return { success: true, data: result };
  }

  private async executeScroll(tab: Tab, params: { direction: string; amount?: number; selector?: string }): Promise<ActionResult> {
    if (params.selector) {
      const code = `
        (function() {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return { error: "Element not found" };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { success: true };
        })()
      `;
      const result = await tab.runJs(code);
      if (result && result.error) {
        return { success: false, error: result.error, recoverable: true };
      }
    } else {
      const direction = params.direction === 'up' ? -1 : 1;
      const amount = params.amount || 500;
      await tab.runJs(`window.scrollBy({ top: ${direction * amount}, behavior: 'smooth' });`);
    }
    await this.sleep(800);
    return { success: true, data: { direction: params.direction, amount: params.amount || 500 } };
  }

  private async executeWait(params: { duration?: number }): Promise<ActionResult> {
    const duration = params.duration || 1000;
    await this.sleep(duration);
    return { success: true, data: { waited: duration } };
  }

  private async executeExtract(tab: Tab, params: { selector: string; attribute?: string; name: string }): Promise<ActionResult> {
    const attr = params.attribute || 'text';
    const code = `
      (function() {
        const elements = document.querySelectorAll(${JSON.stringify(params.selector)});
        if (elements.length === 0) return { error: "No elements found" };
        const results = Array.from(elements).map(el => {
          if (${JSON.stringify(attr)} === 'text') return el.textContent?.trim();
          if (${JSON.stringify(attr)} === 'html') return el.innerHTML;
          if (${JSON.stringify(attr)} === 'value') return el.value;
          return el.getAttribute(${JSON.stringify(attr)});
        }).filter(Boolean);
        return { count: elements.length, data: results.length === 1 ? results[0] : results };
      })()
    `;
    const result = await tab.runJs(code);
    if (result && result.error) {
      return { success: false, error: result.error, recoverable: true };
    }
    return { success: true, data: { [params.name]: result.data } };
  }

  private isRecoverable(type: ActionType, error: string): boolean {
    const nonRecoverable = ['navigation', 'destroyed', 'no active tab'];
    return !nonRecoverable.some(kw => error.toLowerCase().includes(kw));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
