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
          return await this.executeClick(tab, action.params as { selector?: string; x?: number; y?: number });
        case "type":
          return await this.executeType(tab, action.params as { selector?: string; text: string; clearFirst?: boolean; x?: number; y?: number });
        case "key":
          return await this.executeKey(tab, action.params as { key: string; modifiers?: Array<'control' | 'shift' | 'alt' | 'meta'> });
        case "scroll":
          return await this.executeScroll(tab, action.params as { direction: string; amount?: number; selector?: string });
        case "wait":
          return await this.executeWait(action.params as { duration?: number });
        case "extract":
          return await this.executeExtract(tab, action.params as { selector: string; attribute?: string; name: string });
        case "screenshot": {
          const image = await tab.screenshot();
          return { success: true, data: { screenshot: image.toDataURL() } };
        }
        case "finish":
          return { success: true, data: { completed: true, answer: (action.params as { answer?: string }).answer } };
        default:
          return {
            success: false,
            error: `Unknown action type: ${(action as { type?: string }).type}`,
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

  private async executeClick(tab: Tab, params: { selector?: string; x?: number; y?: number }): Promise<ActionResult> {
    // For TikTok and CSP sites, use native click with coordinates
    if (params.x !== undefined && params.y !== undefined) {
      try {
        await this.nativeClick(tab, params.x, params.y);
        await this.sleep(300);
        return { success: true, data: { method: 'native', x: params.x, y: params.y } };
      } catch {
        console.log("[ActionExecutor] Native click failed, trying JS fallback");
      }
    }

    if (!params.selector) {
      return {
        success: false,
        error: "Click needs either x/y coordinates or a CSS selector",
        recoverable: true,
      };
    }

    try {
      // Try standard JS click first
      const code = `
        (function() {
          try {
            const el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return { error: "Element not found" };
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const rect = el.getBoundingClientRect();
            el.click();
            return { success: true, x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
          } catch (e) {
            return { error: e.message };
          }
        })()
      `;
      const result = await tab.runJs(code);
      if (result && result.success) {
        await this.sleep(500);
        return { success: true, data: result };
      }

      // If JS click failed, try native click using coordinates
      if (result && result.x && result.y) {
        await this.nativeClick(tab, result.x, result.y);
        await this.sleep(500);
        return { success: true, data: { method: 'native', x: result.x, y: result.y } };
      }

      return { success: false, error: result?.error || "Click failed", recoverable: true };
    } catch (error) {
      // CSP error - try native click if we have coordinates
      if (params.x !== undefined && params.y !== undefined) {
        try {
          await this.nativeClick(tab, params.x, params.y);
          await this.sleep(500);
          return { success: true, data: { method: 'native_fallback', x: params.x, y: params.y } };
        } catch {
          return { success: false, error: "Native click also failed", recoverable: false };
        }
      }

      const msg = error instanceof Error ? error.message : "Click failed";
      return { success: false, error: msg, recoverable: true };
    }
  }

  private async executeType(tab: Tab, params: { selector?: string; text: string; clearFirst?: boolean; x?: number; y?: number }): Promise<ActionResult> {
    const selector = params.selector;
    if (!selector && (params.x === undefined || params.y === undefined)) {
      return {
        success: false,
        error: "Type needs either a CSS selector or x/y coordinates",
        recoverable: true,
      };
    }

    if (params.x !== undefined && params.y !== undefined) {
      await this.nativeClick(tab, params.x, params.y);
      await this.sleep(120);
      await this.nativeType(tab, params.text);
      await this.sleep(300);
      return { success: true, data: { method: "native", x: params.x, y: params.y } };
    }

    if (!selector) {
      return {
        success: false,
        error: "Type needs a CSS selector when coordinates are not provided",
        recoverable: true,
      };
    }

    const code = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: "Element not found: ${selector.replace(/"/g, '\\"')}" };
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();
        const text = ${JSON.stringify(params.text)};
        const clearFirst = ${params.clearFirst ?? false};

        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          if (clearFirst) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, (el.value || '') + text);
          else el.value = (el.value || '') + text;
          el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, value: el.value, target: el.tagName };
        }

        const editable = el.isContentEditable || el.getAttribute('role') === 'textbox';
        if (editable) {
          if (clearFirst) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            document.execCommand('delete');
          }
          const inserted = document.execCommand('insertText', false, text);
          if (!inserted) {
            el.textContent = (clearFirst ? '' : el.textContent || '') + text;
          }
          el.dispatchEvent(new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true }));
          return { success: true, value: el.textContent, target: 'contenteditable' };
        }

        return { error: "Element is not text-editable" };
      })()
    `;
    try {
      const result = await tab.runJs(code);
      if (result && result.error) {
        return { success: false, error: result.error, recoverable: true };
      }
      await this.sleep(500);
      return { success: true, data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Type failed";
      return { success: false, error: msg, recoverable: true };
    }
  }

  private async executeKey(tab: Tab, params: { key: string; modifiers?: Array<'control' | 'shift' | 'alt' | 'meta'> }): Promise<ActionResult> {
    await this.nativeKey(tab, params.key, params.modifiers || []);
    await this.sleep(250);
    return { success: true, data: { key: params.key, modifiers: params.modifiers || [] } };
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
      try {
        await tab.runJs(`window.scrollBy({ top: ${direction * amount}, behavior: 'smooth' });`);
      } catch {
        await this.nativeScroll(tab, direction * amount);
      }
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
    try {
      const attr = params.attribute || 'text';
      const code = `
        (function() {
          try {
            const elements = document.querySelectorAll(${JSON.stringify(params.selector)});
            if (elements.length === 0) return { error: "No elements found", count: 0 };
            const results = Array.from(elements).map(el => {
              if (${JSON.stringify(attr)} === 'text') return el.textContent?.trim();
              if (${JSON.stringify(attr)} === 'html') return el.innerHTML;
              if (${JSON.stringify(attr)} === 'value') return el.value;
              return el.getAttribute(${JSON.stringify(attr)});
            }).filter(Boolean);
            return { success: true, count: elements.length, data: results.length === 1 ? results[0] : results };
          } catch (e) {
            return { error: e.message || "CSP blocked script execution" };
          }
        })()
      `;
      const result = await tab.runJs(code);
      if (result && result.error) {
        return { success: false, error: result.error, recoverable: true };
      }
      return { success: true, data: { [params.name]: result.data } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Script execution blocked";
      // Check if it's a CSP error
      const isCSP = msg.includes("Script failed to execute") || msg.includes("CSP") || msg.includes("Content Security Policy");
      console.error("[ActionExecutor] Extract failed:", msg);
      return {
        success: false,
        error: isCSP ? "CSP_BLOCKED: This page blocks script execution. Use finish with your observations." : msg,
        recoverable: !isCSP
      };
    }
  }

  private isRecoverable(_type: ActionType, error: string): boolean {
    const nonRecoverable = ['navigation', 'destroyed', 'no active tab'];
    return !nonRecoverable.some(kw => error.toLowerCase().includes(kw));
  }

  async nativeClick(tab: Tab, x: number, y: number): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await this.sleep(50);
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  }

  async nativeScroll(tab: Tab, deltaY: number): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    // Scroll at center of viewport
    const bounds = tab.view.getBounds();
    wc.sendInputEvent({
      type: 'mouseWheel',
      x: bounds.width / 2,
      y: bounds.height / 2,
      deltaX: 0,
      deltaY
    });
  }

  async nativeType(tab: Tab, text: string): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    for (const char of text) {
      wc.sendInputEvent({ type: 'char', keyCode: char });
      await this.sleep(10);
    }
  }

  async nativeKey(tab: Tab, key: string, modifiers: Array<'control' | 'shift' | 'alt' | 'meta'>): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    const normalizedModifiers = modifiers.map(modifier => {
      switch (modifier) {
        case "control": return "control";
        case "shift": return "shift";
        case "alt": return "alt";
        case "meta": return "meta";
      }
    });

    wc.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: normalizedModifiers });
    await this.sleep(40);
    wc.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: normalizedModifiers });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
