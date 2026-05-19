import type { Tab } from "../../Tab";
import type { LLMClient } from "../../LLMClient";
import type {
  AgentAction,
  ActionResult,
  ActionType,
  ClickParams,
  TypeParams,
  KeyParams,
  ScrollParams,
  WaitParams,
  ExtractParams,
  ExtractSchemaParams,
  SelectParams,
  HoverParams,
  WaitForSelectorParams,
} from "../types/AgentTypes";

// Shape returned by inline JS scripts injected into the page
interface JsResult {
  readonly success?: boolean;
  readonly error?: string;
  readonly x?: number;
  readonly y?: number;
  readonly data?: unknown;
}

interface PageStructureSample {
  readonly url: string;
  readonly title: string;
  readonly html: string;
}

const EXTRACT_SCHEMA_SYSTEM_PROMPT = `You write robust DOM scrapers for a browser automation agent.
Given a page HTML sample and a schema of fields, you output ONE self-invoking JavaScript expression that returns a JSON-serialisable array.

Hard rules — violating any of these fails the run:
1. Output ONLY a JS IIFE. No markdown, no commentary, no surrounding text. It MUST start with "(function(" and end with "})()".
2. Use document.querySelectorAll to locate repeating items. Pick the tightest shared container selector you can justify from the HTML.
3. Return a plain Array of plain Objects. Each object has EXACTLY the schema keys, all as strings.
4. For schema fields described as 'url' or 'link', resolve relative hrefs to absolute via "new URL(href, document.baseURI).href". Never return a raw "/path".
5. For text fields, use textContent.trim() and replace runs of whitespace with single spaces.
6. Cap your loop at the requested limit. Skip rows where every field would be empty.
7. NEVER call: fetch, XMLHttpRequest, eval, Function, window.open, location.assign, localStorage, navigator.sendBeacon. NEVER mutate the page.
8. Wrap your top-level logic in try/catch and on failure return []. Do NOT throw.

Skeleton:
(function() {
  try {
    var items = document.querySelectorAll('SELECTOR');
    var out = [];
    for (var i = 0; i < items.length && out.length < LIMIT; i++) {
      var el = items[i];
      var row = {
        field1: (el.querySelector('...') || {}).textContent ? el.querySelector('...').textContent.trim() : '',
        // ...
      };
      out.push(row);
    }
    return out;
  } catch (e) { return []; }
})()`;

export class ActionExecutor {
  private readonly llmClient: LLMClient;

  constructor(llmClient: LLMClient) {
    this.llmClient = llmClient;
  }

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
          return await this.executeNavigate(
            tab,
            action.params as { url: string },
          );
        case "click":
          return await this.executeClick(tab, action.params as ClickParams);
        case "type":
          return await this.executeType(tab, action.params as TypeParams);
        case "key":
          return await this.executeKey(tab, action.params as KeyParams);
        case "scroll":
          return await this.executeScroll(tab, action.params as ScrollParams);
        case "wait":
          return await this.executeWait(action.params as WaitParams);
        case "extract":
          return await this.executeExtract(tab, action.params as ExtractParams);
        case "extractSchema":
          return await this.executeExtractSchema(
            tab,
            action.params as ExtractSchemaParams,
          );
        case "screenshot": {
          const image = await tab.screenshot({ maxWidth: 800 });
          return { success: true, data: { screenshot: image.toDataURL() } };
        }
        case "finish":
          return {
            success: true,
            data: {
              completed: true,
              answer: (action.params as { answer?: string }).answer,
            },
          };
        case "select":
          return await this.executeSelect(tab, action.params as SelectParams);
        case "hover":
          return await this.executeHover(tab, action.params as HoverParams);
        case "back":
          return await this.executeBack(tab);
        case "forward":
          return await this.executeForward(tab);
        case "waitForSelector":
          return await this.executeWaitForSelector(
            tab,
            action.params as WaitForSelectorParams,
          );
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

  private async executeNavigate(
    tab: Tab,
    params: { url: string },
  ): Promise<ActionResult> {
    await tab.loadURL(params.url);
    await this.sleep(2000);
    return { success: true, data: { url: params.url } };
  }

  private async executeClick(
    tab: Tab,
    params: ClickParams,
  ): Promise<ActionResult> {
    // Native click via coordinates — works on CSP sites; skip when targeting an iframe
    if (!params.frame && params.x !== undefined && params.y !== undefined) {
      try {
        await this.nativeClick(tab, params.x, params.y);
        await this.sleep(300);
        return {
          success: true,
          data: { method: "native", x: params.x, y: params.y },
        };
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

    const frameSetup = this.resolveDocJs(params.frame);
    try {
      const code = `
        (function() {
          try {
            ${frameSetup}
            const el = __doc.querySelector(${JSON.stringify(params.selector)});
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
      const result = (await tab.runJs(code)) as JsResult;
      if (result && result.success) {
        await this.sleep(500);
        return { success: true, data: result };
      }

      // JS click failed — try native click using element coords (main frame only)
      if (!params.frame && result?.x && result?.y) {
        await this.nativeClick(tab, result.x, result.y);
        await this.sleep(500);
        return {
          success: true,
          data: { method: "native", x: result.x, y: result.y },
        };
      }

      return {
        success: false,
        error: result?.error || "Click failed",
        recoverable: true,
      };
    } catch (error) {
      if (!params.frame && params.x !== undefined && params.y !== undefined) {
        try {
          await this.nativeClick(tab, params.x, params.y);
          await this.sleep(500);
          return {
            success: true,
            data: { method: "native_fallback", x: params.x, y: params.y },
          };
        } catch {
          return {
            success: false,
            error: "Native click also failed",
            recoverable: false,
          };
        }
      }
      const msg = error instanceof Error ? error.message : "Click failed";
      return { success: false, error: msg, recoverable: true };
    }
  }

  private async executeType(
    tab: Tab,
    params: TypeParams,
  ): Promise<ActionResult> {
    const selector = params.selector;
    if (!selector && (params.x === undefined || params.y === undefined)) {
      return {
        success: false,
        error: "Type needs either a CSS selector or x/y coordinates",
        recoverable: true,
      };
    }

    // Native path — coordinates only, no frame support needed
    if (!params.frame && params.x !== undefined && params.y !== undefined) {
      await this.nativeClick(tab, params.x, params.y);
      await this.sleep(120);
      await this.nativeType(tab, params.text);
      await this.sleep(300);
      return {
        success: true,
        data: { method: "native", x: params.x, y: params.y },
      };
    }

    if (!selector) {
      return {
        success: false,
        error: "Type needs a CSS selector when coordinates are not provided",
        recoverable: true,
      };
    }

    const frameSetup = this.resolveDocJs(params.frame);
    const code = `
      (function() {
        ${frameSetup}
        const el = __doc.querySelector(${JSON.stringify(selector)});
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
      const result = (await tab.runJs(code)) as JsResult;
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

  private async executeKey(tab: Tab, params: KeyParams): Promise<ActionResult> {
    await this.nativeKey(
      tab,
      params.key,
      (params.modifiers as Array<"control" | "shift" | "alt" | "meta">) || [],
    );
    await this.sleep(250);
    return {
      success: true,
      data: { key: params.key, modifiers: params.modifiers || [] },
    };
  }

  private async executeScroll(
    tab: Tab,
    params: ScrollParams,
  ): Promise<ActionResult> {
    if (params.selector) {
      const code = `
        (function() {
          const el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return { error: "Element not found" };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { success: true };
        })()
      `;
      const result = (await tab.runJs(code)) as JsResult;
      if (result && result.error) {
        return { success: false, error: result.error, recoverable: true };
      }
    } else {
      const direction = params.direction === "up" ? -1 : 1;
      const amount = params.amount || 500;
      try {
        await tab.runJs(
          `window.scrollBy({ top: ${direction * amount}, behavior: 'smooth' });`,
        );
      } catch {
        await this.nativeScroll(tab, direction * amount);
      }
    }
    await this.sleep(800);
    return {
      success: true,
      data: { direction: params.direction, amount: params.amount || 500 },
    };
  }

  private async executeSelect(
    tab: Tab,
    params: SelectParams,
  ): Promise<ActionResult> {
    const frameSetup = this.resolveDocJs(params.frame);
    const code = `
      (function() {
        ${frameSetup}
        var el = __doc.querySelector(${JSON.stringify(params.selector)});
        if (!el) return { error: "Select element not found: " + ${JSON.stringify(params.selector)} };
        if (el.tagName !== 'SELECT') return { error: "Element is not a <select>: " + ${JSON.stringify(params.selector)} };
        var val = ${JSON.stringify(params.value)};
        var opt = Array.from(el.options).find(function(o) {
          return o.value === val || o.text.trim().toLowerCase().includes(val.toLowerCase());
        });
        if (!opt) return { error: "Option not found: " + val + ". Available: " + Array.from(el.options).map(function(o){ return o.value; }).join(', ') };
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { success: true, selected: opt.value, text: opt.text };
      })()
    `;
    try {
      const result = (await tab.runJs(code)) as JsResult;
      if (result?.error) {
        return { success: false, error: result.error, recoverable: true };
      }
      await this.sleep(300);
      return { success: true, data: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Select failed";
      return { success: false, error: msg, recoverable: true };
    }
  }

  private async executeHover(
    tab: Tab,
    params: HoverParams,
  ): Promise<ActionResult> {
    let targetX = params.x;
    let targetY = params.y;

    if (params.selector && (targetX === undefined || targetY === undefined)) {
      const code = `
        (function() {
          var el = document.querySelector(${JSON.stringify(params.selector)});
          if (!el) return { error: "Element not found" };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          var r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `;
      try {
        const result = (await tab.runJs(code)) as {
          x?: number;
          y?: number;
          error?: string;
        };
        if (result?.error) {
          return { success: false, error: result.error, recoverable: true };
        }
        targetX = result.x;
        targetY = result.y;
      } catch {
        return {
          success: false,
          error: "Could not locate element for hover",
          recoverable: true,
        };
      }
    }

    if (targetX === undefined || targetY === undefined) {
      return {
        success: false,
        error: "Hover needs a selector or x,y coordinates",
        recoverable: true,
      };
    }

    // sendInputEvent mouseMove triggers Chromium's internal hover state (CSS :hover)
    const wc = tab.nativeWebContents;
    wc.sendInputEvent({ type: "mouseMove", x: targetX, y: targetY });
    await this.sleep(400);
    return { success: true, data: { x: targetX, y: targetY } };
  }

  private async executeBack(tab: Tab): Promise<ActionResult> {
    tab.goBack();
    await this.sleep(1500);
    return { success: true, data: { navigated: "back" } };
  }

  private async executeForward(tab: Tab): Promise<ActionResult> {
    tab.goForward();
    await this.sleep(1500);
    return { success: true, data: { navigated: "forward" } };
  }

  private async executeWaitForSelector(
    tab: Tab,
    params: WaitForSelectorParams,
  ): Promise<ActionResult> {
    const timeout = params.timeout ?? 10000;
    const start = Date.now();
    const poll = 250;

    while (Date.now() - start < timeout) {
      try {
        const code = `
          (function() {
            var el = document.querySelector(${JSON.stringify(params.selector)});
            if (!el) return false;
            ${params.visible ? "var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;" : "return true;"}
          })()
        `;
        const found = (await tab.runJs(code)) as boolean;
        if (found) {
          return {
            success: true,
            data: { selector: params.selector, waitedMs: Date.now() - start },
          };
        }
      } catch {
        // page may be mid-navigation — keep polling
      }
      await this.sleep(poll);
    }

    return {
      success: false,
      error: `"${params.selector}" not found after ${timeout}ms`,
      recoverable: true,
    };
  }

  // Returns a JS snippet that sets __doc to either document or an iframe's contentDocument.
  private resolveDocJs(frame: string | undefined): string {
    if (!frame) return "var __doc = document;";
    return `
      var __iframe = document.querySelector(${JSON.stringify(frame)});
      if (!__iframe) return { error: "Frame not found: " + ${JSON.stringify(frame)} };
      var __doc = __iframe.contentDocument || (__iframe.contentWindow && __iframe.contentWindow.document);
      if (!__doc) return { error: "Cannot access frame (cross-origin or not loaded)" };
    `;
  }

  private async executeWait(params: WaitParams): Promise<ActionResult> {
    const duration = params.duration || 1000;
    await this.sleep(duration);
    return { success: true, data: { waited: duration } };
  }

  private async executeExtract(
    tab: Tab,
    params: ExtractParams,
  ): Promise<ActionResult> {
    try {
      const attr = params.attribute || "text";
      const frameSetup = this.resolveDocJs(params.frame);
      const code = `
        (function() {
          try {
            ${frameSetup}
            const elements = __doc.querySelectorAll(${JSON.stringify(params.selector)});
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
      const result = (await tab.runJs(code)) as JsResult;
      if (result && result.error) {
        return { success: false, error: result.error, recoverable: true };
      }
      return { success: true, data: { [params.name]: result.data } };
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Script execution blocked";
      const isCSP =
        msg.includes("Script failed to execute") ||
        msg.includes("CSP") ||
        msg.includes("Content Security Policy");
      console.error("[ActionExecutor] Extract failed:", msg);
      return {
        success: false,
        error: isCSP
          ? "CSP_BLOCKED: This page blocks script execution. Use finish with your observations."
          : msg,
        recoverable: !isCSP,
      };
    }
  }

  private async executeExtractSchema(
    tab: Tab,
    params: ExtractSchemaParams,
  ): Promise<ActionResult> {
    const fields = Object.keys(params.schema);
    if (fields.length === 0) {
      return {
        success: false,
        error: "extractSchema requires a non-empty schema",
        recoverable: false,
      };
    }

    const limit = Math.max(1, Math.min(params.limit ?? 50, 200));

    let pageStructure: PageStructureSample;
    try {
      pageStructure = await this.samplePageStructure(tab, params.frame);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Page sample failed";
      const isCSP =
        msg.includes("Script failed to execute") ||
        msg.includes("CSP") ||
        msg.includes("Content Security Policy");
      return {
        success: false,
        error: isCSP
          ? "CSP_BLOCKED: Cannot sample page structure for extractSchema."
          : msg,
        recoverable: !isCSP,
      };
    }

    const interactiveElements = await tab
      .getInteractiveElements()
      .catch(() => null);

    const prompt = this.buildExtractSchemaPrompt({
      schema: params.schema,
      limit,
      containerHint: params.containerHint,
      frame: params.frame,
      pageStructure,
      interactiveElements,
    });

    const llmResponse = await this.llmClient.generateText(
      prompt,
      0.1,
      EXTRACT_SCHEMA_SYSTEM_PROMPT,
    );
    if (!llmResponse) {
      return {
        success: false,
        error: "LLM did not return an extraction script",
        recoverable: true,
      };
    }

    const script = this.extractIifeFromLlmResponse(llmResponse);
    if (!script) {
      return {
        success: false,
        error: "Could not parse a JS IIFE from LLM response",
        recoverable: true,
      };
    }

    const wrappedScript = this.wrapSchemaScript(
      script,
      params.frame,
      fields,
      limit,
    );

    let raw: unknown;
    try {
      raw = await tab.runJs(wrappedScript);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Script eval failed";
      const isCSP =
        msg.includes("Script failed to execute") ||
        msg.includes("CSP") ||
        msg.includes("Content Security Policy");
      return {
        success: false,
        error: isCSP
          ? "CSP_BLOCKED: Generated scraper could not run on this page."
          : msg,
        recoverable: !isCSP,
      };
    }

    if (this.isJsError(raw)) {
      return { success: false, error: raw.error, recoverable: true };
    }

    const rows = this.normalizeExtractionRows(raw, fields, limit);
    if (rows.length === 0) {
      return {
        success: false,
        error: "Generated scraper returned zero matching rows",
        recoverable: true,
      };
    }

    return {
      success: true,
      data: { [params.name]: rows },
    };
  }

  private async samplePageStructure(
    tab: Tab,
    frame: string | undefined,
  ): Promise<PageStructureSample> {
    const frameSetup = this.resolveDocJs(frame);
    const code = `
      (function() {
        try {
          ${frameSetup}
          var win = __doc.defaultView || window;
          var root = __doc.body || __doc.documentElement;
          if (!root) return { error: "No document body" };
          var html = root.outerHTML || '';
          html = html.replace(/<script[\\s\\S]*?<\\/script>/gi, '');
          html = html.replace(/<style[\\s\\S]*?<\\/style>/gi, '');
          html = html.replace(/<noscript[\\s\\S]*?<\\/noscript>/gi, '');
          html = html.replace(/<!--([\\s\\S]*?)-->/g, '');
          html = html.replace(/\\s+/g, ' ');
          return {
            url: (win.location && win.location.href) || '',
            title: __doc.title || '',
            html: html.substring(0, 8000)
          };
        } catch (e) {
          return { error: e && e.message ? e.message : 'Sample failed' };
        }
      })()
    `;
    const result = (await tab.runJs(code)) as
      | { readonly error: string }
      | PageStructureSample;
    if ("error" in result) throw new Error(result.error);
    return result;
  }

  private buildExtractSchemaPrompt(input: {
    readonly schema: Readonly<Record<string, string>>;
    readonly limit: number;
    readonly containerHint?: string;
    readonly frame?: string;
    readonly pageStructure: PageStructureSample;
    readonly interactiveElements: string | null;
  }): string {
    const schemaLines = Object.entries(input.schema)
      .map(([field, hint]) => `- ${field}: ${hint}`)
      .join("\n");

    const fieldNames = Object.keys(input.schema).join(", ");

    const elementsBlock = input.interactiveElements
      ? `\nInteractive elements on page (compact list, use as hints):\n${input.interactiveElements.substring(0, 1600)}\n`
      : "";

    const frameNote = input.frame
      ? `\nNote: targeting iframe selector ${input.frame}. The page sample below is from inside that frame.`
      : "";

    return `Page URL: ${input.pageStructure.url}
Page title: ${input.pageStructure.title}${frameNote}

Schema (extract these fields per item):
${schemaLines}

Container hint (free-text guidance from agent): ${input.containerHint || "(none — figure out the repeating container yourself)"}

Maximum items: ${input.limit}
Output field names: [${fieldNames}]
${elementsBlock}
HTML sample (truncated, scripts/styles stripped):
${input.pageStructure.html}

Write the JS IIFE now. Return ONLY the IIFE expression — no markdown fences, no commentary, no \`return\` statement outside the IIFE.`;
  }

  private extractIifeFromLlmResponse(text: string): string | null {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^```(?:javascript|js)?\s*/i, "");
    cleaned = cleaned.replace(/```\s*$/i, "");
    cleaned = cleaned.trim();
    if (!cleaned.startsWith("(") || !cleaned.endsWith(")")) {
      const match = cleaned.match(
        /\(function\s*\([^)]*\)\s*\{[\s\S]*\}\s*\)\s*\(\s*\)/,
      );
      if (!match) return null;
      cleaned = match[0];
    }
    return cleaned;
  }

  private wrapSchemaScript(
    script: string,
    frame: string | undefined,
    fields: readonly string[],
    limit: number,
  ): string {
    const frameSetup = this.resolveDocJs(frame);
    return `
      (function() {
        try {
          ${frameSetup}
          var __limit = ${limit};
          var __fields = ${JSON.stringify(fields)};
          var __result = (${script});
          if (!Array.isArray(__result)) return { error: "Scraper did not return an array" };
          var __rows = __result.slice(0, __limit).map(function(row) {
            var clean = {};
            if (row && typeof row === 'object') {
              for (var i = 0; i < __fields.length; i++) {
                var key = __fields[i];
                var val = row[key];
                if (val === undefined || val === null) { clean[key] = ''; continue; }
                if (typeof val === 'string') { clean[key] = val.trim().substring(0, 1000); continue; }
                if (typeof val === 'number' || typeof val === 'boolean') { clean[key] = String(val); continue; }
                try { clean[key] = String(val).substring(0, 1000); } catch (e) { clean[key] = ''; }
              }
            }
            return clean;
          });
          return __rows;
        } catch (e) {
          return { error: e && e.message ? 'Generated scraper threw: ' + e.message : 'Generated scraper failed' };
        }
      })()
    `;
  }

  private isJsError(value: unknown): value is { readonly error: string } {
    return (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof (value as { error: unknown }).error === "string"
    );
  }

  private normalizeExtractionRows(
    raw: unknown,
    fields: readonly string[],
    limit: number,
  ): ReadonlyArray<Record<string, string>> {
    if (!Array.isArray(raw)) return [];
    const out: Array<Record<string, string>> = [];
    for (const item of raw.slice(0, limit)) {
      if (!item || typeof item !== "object") continue;
      const row: Record<string, string> = {};
      let hasAny = false;
      for (const field of fields) {
        const value = (item as Record<string, unknown>)[field];
        const str =
          typeof value === "string"
            ? value.trim()
            : value === undefined || value === null
              ? ""
              : String(value);
        row[field] = str;
        if (str.length > 0) hasAny = true;
      }
      if (hasAny) out.push(row);
    }
    return out;
  }

  private isRecoverable(_type: ActionType, error: string): boolean {
    const nonRecoverable = ["navigation", "destroyed", "no active tab"];
    return !nonRecoverable.some((kw) => error.toLowerCase().includes(kw));
  }

  async nativeClick(tab: Tab, x: number, y: number): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    wc.sendInputEvent({
      type: "mouseDown",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await this.sleep(50);
    wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
  }

  async nativeScroll(tab: Tab, deltaY: number): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    // Scroll at center of viewport
    const bounds = tab.view.getBounds();
    wc.sendInputEvent({
      type: "mouseWheel",
      x: bounds.width / 2,
      y: bounds.height / 2,
      deltaX: 0,
      deltaY,
    });
  }

  async nativeType(tab: Tab, text: string): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    for (const char of text) {
      wc.sendInputEvent({ type: "char", keyCode: char });
      await this.sleep(10);
    }
  }

  async nativeKey(
    tab: Tab,
    key: string,
    modifiers: ReadonlyArray<"control" | "shift" | "alt" | "meta">,
  ): Promise<void> {
    const wc = tab.nativeWebContents;
    if (!wc) throw new Error("No webContents available");

    const normalizedModifiers = modifiers.map((modifier) => {
      switch (modifier) {
        case "control":
          return "control";
        case "shift":
          return "shift";
        case "alt":
          return "alt";
        case "meta":
          return "meta";
      }
    });

    wc.sendInputEvent({
      type: "keyDown",
      keyCode: key,
      modifiers: normalizedModifiers,
    });
    await this.sleep(40);
    wc.sendInputEvent({
      type: "keyUp",
      keyCode: key,
      modifiers: normalizedModifiers,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
