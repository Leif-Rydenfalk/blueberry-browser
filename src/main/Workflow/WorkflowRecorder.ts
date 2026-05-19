import { v4 as uuidv4 } from "uuid";
import { Menu } from "electron";
import type { Tab } from "../Tab";
import type { Window } from "../Window";
import type {
  Workflow,
  WorkflowStep,
  RecordingState,
  DomEventPayload,
  WorkflowDataset,
} from "./WorkflowTypes";

export class WorkflowRecorder {
  private recording = false;
  private startedAt: number | null = null;
  private steps: WorkflowStep[] = [];
  private lastUrl: string | null = null;
  private activeDataset: WorkflowDataset | null = null;
  // selector → column to apply to the *next* interaction step matching that selector
  private pendingBindings: Map<string, string> = new Map();
  private onUpdate: ((state: RecordingState) => void) | null = null;
  private onStepCaptured: ((step: WorkflowStep) => void) | null = null;

  // Bound listener references so we can remove them
  private readonly navListeners: Map<
    string,
    (event: Electron.Event, url: string) => void
  > = new Map();

  setOnUpdate(cb: (state: RecordingState) => void): void {
    this.onUpdate = cb;
  }

  setOnStepCaptured(cb: (step: WorkflowStep) => void): void {
    this.onStepCaptured = cb;
  }

  start(): void {
    if (this.recording) return;
    this.recording = true;
    this.startedAt = Date.now();
    this.steps = [];
    this.lastUrl = null;
    this.emitState();
  }

  stop(name: string): Workflow | null {
    if (!this.recording || this.steps.length === 0) {
      this.recording = false;
      this.startedAt = null;
      this.steps = [];
      return null;
    }

    const firstStep = this.steps[0];
    const lastStep = this.steps[this.steps.length - 1];
    const workflow: Workflow = {
      id: uuidv4(),
      name,
      createdAt: this.startedAt!,
      duration: Date.now() - this.startedAt!,
      steps: [...this.steps],
      startUrl: firstStep.url,
      endUrl: lastStep.url,
      stepCount: this.steps.length,
      dataset: this.activeDataset ?? undefined,
    };

    this.recording = false;
    this.startedAt = null;
    this.steps = [];
    this.lastUrl = null;
    this.pendingBindings.clear();
    this.emitState();

    return workflow;
  }

  cancel(): void {
    this.recording = false;
    this.startedAt = null;
    this.steps = [];
    this.lastUrl = null;
    this.pendingBindings.clear();
    this.emitState();
  }

  setActiveDataset(dataset: WorkflowDataset | null): void {
    this.activeDataset = dataset;
  }

  getActiveDataset(): WorkflowDataset | null {
    return this.activeDataset;
  }

  // Find the most-recent interaction step matching this selector and bind it
  // to the given column. If no matching step exists yet (the user right-clicked
  // *before* typing), register a pending binding that will apply to the next
  // matching step.
  bindLatestInteraction(
    selector: string,
    column: string,
  ): {
    readonly applied: "step" | "pending" | "none";
    readonly stepId?: string;
  } {
    if (!this.recording) return { applied: "none" };
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i];
      if (step.data.type !== "interaction") continue;
      if (step.data.payload.selector !== selector) continue;
      const replaced: WorkflowStep = {
        ...step,
        data: {
          type: "interaction",
          payload: { ...step.data.payload, parameter: { column } },
        },
      };
      this.steps[i] = replaced;
      this.onStepCaptured?.(replaced);
      this.emitState();
      return { applied: "step", stepId: replaced.id };
    }
    this.pendingBindings.set(selector, column);
    return { applied: "pending" };
  }

  addAnnotation(text: string, currentUrl: string, pageTitle: string): void {
    if (!this.recording) return;
    const step: WorkflowStep = {
      id: uuidv4(),
      timestamp: Date.now(),
      url: currentUrl,
      pageTitle,
      data: { type: "annotation", payload: { text } },
    };
    this.steps.push(step);
    this.onStepCaptured?.(step);
    this.emitState();
  }

  captureInteraction(event: DomEventPayload): void {
    if (!this.recording) return;
    if (this.shouldCoalesceInteraction(event)) return;
    const pendingColumn = this.pendingBindings.get(event.selector);
    if (pendingColumn) this.pendingBindings.delete(event.selector);
    const step: WorkflowStep = {
      id: uuidv4(),
      timestamp: event.timestamp || Date.now(),
      url: event.url,
      pageTitle: event.pageTitle,
      data: {
        type: "interaction",
        payload: {
          eventType: event.eventType,
          tag: event.tag,
          selector: event.selector,
          xpath: event.xpath,
          label: event.label,
          role: event.role,
          value: event.value,
          key: event.key,
          x: event.x,
          y: event.y,
          ...(pendingColumn ? { parameter: { column: pendingColumn } } : {}),
        },
      },
    };
    this.steps.push(step);
    this.onStepCaptured?.(step);
    this.emitState();
  }

  // Replace the previous "input" step on the same selector with this one — the
  // user is still typing into the same field. "change" events flush separately.
  private shouldCoalesceInteraction(event: DomEventPayload): boolean {
    if (event.eventType !== "input") return false;
    const last = this.steps[this.steps.length - 1];
    if (!last || last.data.type !== "interaction") return false;
    const lastPayload = last.data.payload;
    if (lastPayload.eventType !== "input") return false;
    if (lastPayload.selector !== event.selector) return false;
    const replaced: WorkflowStep = {
      ...last,
      timestamp: event.timestamp || Date.now(),
      data: {
        type: "interaction",
        payload: {
          ...lastPayload,
          value: event.value,
        },
      },
    };
    this.steps[this.steps.length - 1] = replaced;
    this.onStepCaptured?.(replaced);
    this.emitState();
    return true;
  }

  captureNavigation(tab: Tab, toUrl: string): void {
    if (!this.recording) return;
    // Deduplicate rapid same-URL events
    if (toUrl === this.lastUrl) return;
    this.lastUrl = toUrl;

    const step: WorkflowStep = {
      id: uuidv4(),
      timestamp: Date.now(),
      url: toUrl,
      pageTitle: tab.title,
      data: {
        type: "navigation",
        payload: { fromUrl: this.lastUrl, toUrl, pageTitle: tab.title },
      },
    };
    this.steps.push(step);
    this.onStepCaptured?.(step);
    this.emitState();

    // Capture screenshot async without blocking navigation
    tab
      .screenshot()
      .then((image) => {
        const screenshotStep: WorkflowStep = {
          id: uuidv4(),
          timestamp: Date.now(),
          url: toUrl,
          pageTitle: tab.title,
          data: {
            type: "screenshot",
            payload: { imageData: image.toDataURL() },
          },
        };
        this.steps.push(screenshotStep);
        this.onStepCaptured?.(screenshotStep);
      })
      .catch((err) => {
        console.error("[WorkflowRecorder] Screenshot failed:", err);
      });
  }

  hookTab(tab: Tab): void {
    const listener = (_event: Electron.Event, url: string): void => {
      this.captureNavigation(tab, url);
    };
    this.navListeners.set(tab.id, listener);
    tab.webContents.on("did-navigate", listener);
    tab.webContents.on("did-navigate-in-page", listener);
    tab.webContents.on("context-menu", (_event, params) => {
      if (!params.isEditable) return;
      this.handleContextMenu(tab, params.x, params.y);
    });
  }

  unhookTab(tab: Tab): void {
    const listener = this.navListeners.get(tab.id);
    if (!listener) return;
    tab.webContents.removeListener("did-navigate", listener);
    tab.webContents.removeListener("did-navigate-in-page", listener);
    this.navListeners.delete(tab.id);
    tab.webContents.removeAllListeners("context-menu");
  }

  // Show a "Bind to column ▸" submenu on right-click when a dataset is
  // active during a recording. Resolves the selector for the right-clicked
  // element via the page, then binds via [[bindLatestInteraction]].
  private handleContextMenu(tab: Tab, x: number, y: number): void {
    if (!this.recording) return;
    const dataset = this.activeDataset;
    if (!dataset || dataset.columns.length === 0) return;

    const submenu = dataset.columns.map((column) => ({
      label: column,
      click: () => {
        void this.bindByPoint(tab, x, y, column);
      },
    }));

    const menu = Menu.buildFromTemplate([
      {
        label: "Bind input to column",
        submenu,
      },
    ]);
    // No window option → popup attaches to the currently-focused window.
    menu.popup();
  }

  private async bindByPoint(
    tab: Tab,
    x: number,
    y: number,
    column: string,
  ): Promise<void> {
    const selector = await this.resolveSelectorAtPoint(tab, x, y);
    if (!selector) {
      console.error("[WorkflowRecorder] No element under right-click");
      return;
    }
    const result = this.bindLatestInteraction(selector, column);
    if (result.applied === "none") {
      console.error("[WorkflowRecorder] Could not bind selector to column");
    }
  }

  private async resolveSelectorAtPoint(
    tab: Tab,
    x: number,
    y: number,
  ): Promise<string | null> {
    const code = `
      (function() {
        try {
          var el = document.elementFromPoint(${x}, ${y});
          if (!el) return null;
          var anchor = el.closest('input, textarea, select, [contenteditable=true], a[href], button, [role=button], [role=link]') || el;
          function escape(v){ return (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(v) : v; }
          if (anchor.id) return '#' + escape(anchor.id);
          var t = anchor.getAttribute('data-testid');
          if (t) return '[data-testid="' + t + '"]';
          var n = anchor.getAttribute('name');
          if (n) return anchor.tagName.toLowerCase() + '[name="' + n + '"]';
          var path = [];
          var node = anchor;
          var d = 0;
          while (node && node.nodeType === 1 && d < 5) {
            var part = node.tagName.toLowerCase();
            if (node.id) { part = '#' + escape(node.id); path.unshift(part); break; }
            if (typeof node.className === 'string' && node.className.trim()) {
              var cls = node.className.trim().split(/\\s+/).slice(0,2).map(function(c){ return '.' + escape(c); }).join('');
              part += cls;
            }
            var parent = node.parentElement;
            if (parent) {
              var siblings = Array.from(parent.children).filter(function(c){ return c.tagName === node.tagName; });
              if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
            }
            path.unshift(part);
            node = node.parentElement;
            d++;
          }
          return path.join(' > ');
        } catch (e) { return null; }
      })()
    `;
    try {
      const result = (await tab.runJs(code)) as string | null;
      return typeof result === "string" && result.length > 0 ? result : null;
    } catch (error) {
      console.error("[WorkflowRecorder] selector resolve failed:", error);
      return null;
    }
  }

  hookAllTabs(window: Window): void {
    for (const tab of window.allTabs) {
      this.hookTab(tab);
    }
  }

  getState(): RecordingState {
    return {
      isRecording: this.recording,
      startedAt: this.startedAt,
      stepCount: this.steps.length,
      currentUrl: this.lastUrl,
    };
  }

  get isRecording(): boolean {
    return this.recording;
  }

  private emitState(): void {
    this.onUpdate?.(this.getState());
  }
}
