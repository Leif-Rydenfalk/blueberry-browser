import { ipcRenderer } from "electron";

const DOM_EVENT = "workflow:dom-event";
const RECORDING_ACTIVE_CHANGED = "workflow:recording-active-changed";
const GET_RECORDING_STATE = "workflow:get-recording-state";

const INTERACTIVE_SELECTOR =
  "a[href], button, input, select, textarea, [role=button], [role=link], [role=menuitem], [role=tab], [contenteditable=true]";

const INPUT_DEBOUNCE_MS = 600;
const MAX_LABEL_LEN = 80;
const MAX_VALUE_LEN = 400;

type EventType = "click" | "input" | "change" | "submit" | "keydown";

interface DomEventPayload {
  eventType: EventType;
  tag: string;
  selector: string;
  xpath: string;
  label: string;
  role?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  url: string;
  pageTitle: string;
  timestamp: number;
}

let isRecording = false;
const pendingInputTimers = new Map<Element, ReturnType<typeof setTimeout>>();

function escapeIdent(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/(["\\#.[\]:>+~*])/g, "\\$1");
}

function computeSelector(el: Element): string {
  if (el.id) return `#${escapeIdent(el.id)}`;
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId}"]`;
  const name = el.getAttribute("name");
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;

  const path: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 5) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      part = `#${escapeIdent(node.id)}`;
      path.unshift(part);
      break;
    }
    if (typeof node.className === "string" && node.className.trim()) {
      const cls = node.className
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((c) => `.${escapeIdent(c)}`)
        .join("");
      part += cls;
    }
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(
        (c) => c.tagName === node!.tagName,
      );
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(node) + 1;
        part += `:nth-of-type(${idx})`;
      }
    }
    path.unshift(part);
    node = node.parentElement;
    depth++;
  }
  return path.join(" > ");
}

function computeXPath(el: Element): string {
  if (el.id) return `//*[@id="${el.id}"]`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let idx = 1;
    let sib = node.previousElementSibling;
    while (sib) {
      if (sib.tagName === node.tagName) idx++;
      sib = sib.previousElementSibling;
    }
    parts.unshift(`${node.tagName.toLowerCase()}[${idx}]`);
    node = node.parentElement;
  }
  return `/${parts.join("/")}`;
}

function clipText(value: string | null | undefined, max: number): string {
  if (!value) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max
    ? `${normalized.substring(0, max - 1)}…`
    : normalized;
}

function computeLabel(el: Element): string {
  const raw =
    (el as HTMLElement).innerText ||
    (el as HTMLInputElement).value ||
    (el as HTMLInputElement).placeholder ||
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    el.getAttribute("title") ||
    "";
  return clipText(raw, MAX_LABEL_LEN);
}

function findInteractiveTarget(target: EventTarget | null): Element | null {
  if (!target || !(target as Element).closest) return null;
  const direct = target as Element;
  const interactive = direct.closest(INTERACTIVE_SELECTOR);
  if (interactive) return interactive;
  if (direct.nodeType === 1) return direct;
  return null;
}

function basePayload(el: Element, eventType: EventType): DomEventPayload {
  const role = el.getAttribute("role") || undefined;
  return {
    eventType,
    tag: el.tagName.toLowerCase(),
    selector: computeSelector(el),
    xpath: computeXPath(el),
    label: computeLabel(el),
    role,
    url: location.href,
    pageTitle: document.title || "",
    timestamp: Date.now(),
  };
}

function send(payload: DomEventPayload): void {
  if (!isRecording) return;
  try {
    ipcRenderer.send(DOM_EVENT, payload);
  } catch {
    // preload-only IPC failures should never break the page
  }
}

function handleClick(event: MouseEvent): void {
  if (!isRecording) return;
  const el = findInteractiveTarget(event.target);
  if (!el) return;
  const payload = basePayload(el, "click");
  send({ ...payload, x: event.clientX, y: event.clientY });
}

function readValue(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const v = (el as HTMLInputElement).value;
    return clipText(v, MAX_VALUE_LEN);
  }
  if ((el as HTMLElement).isContentEditable) {
    return clipText((el as HTMLElement).innerText, MAX_VALUE_LEN);
  }
  return "";
}

function handleInput(event: Event): void {
  if (!isRecording) return;
  const target = event.target as Element | null;
  if (!target) return;
  const existing = pendingInputTimers.get(target);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingInputTimers.delete(target);
    const payload = basePayload(target, "input");
    send({ ...payload, value: readValue(target) });
  }, INPUT_DEBOUNCE_MS);
  pendingInputTimers.set(target, timer);
}

function handleChange(event: Event): void {
  if (!isRecording) return;
  const target = event.target as Element | null;
  if (!target) return;
  const pending = pendingInputTimers.get(target);
  if (pending) {
    clearTimeout(pending);
    pendingInputTimers.delete(target);
  }
  const tag = target.tagName.toLowerCase();
  if (tag !== "select" && tag !== "input" && tag !== "textarea") return;
  const payload = basePayload(target, "change");
  send({ ...payload, value: readValue(target) });
}

function handleSubmit(event: Event): void {
  if (!isRecording) return;
  const target = event.target as Element | null;
  if (!target) return;
  send(basePayload(target, "submit"));
}

function handleKeyDown(event: KeyboardEvent): void {
  if (!isRecording) return;
  if (!["Enter", "Escape", "Tab"].includes(event.key)) return;
  const target = event.target as Element | null;
  if (!target) return;
  const payload = basePayload(target, "keydown");
  send({ ...payload, key: event.key });
}

function attachListeners(): void {
  window.addEventListener("click", handleClick, {
    capture: true,
    passive: true,
  });
  window.addEventListener("input", handleInput, {
    capture: true,
    passive: true,
  });
  window.addEventListener("change", handleChange, {
    capture: true,
    passive: true,
  });
  window.addEventListener("submit", handleSubmit, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", handleKeyDown, {
    capture: true,
    passive: true,
  });
}

async function init(): Promise<void> {
  attachListeners();

  ipcRenderer.on(RECORDING_ACTIVE_CHANGED, (_event, active: boolean) => {
    isRecording = !!active;
    if (!active) {
      pendingInputTimers.forEach((t) => clearTimeout(t));
      pendingInputTimers.clear();
    }
  });

  try {
    const state = (await ipcRenderer.invoke(GET_RECORDING_STATE)) as {
      isRecording?: boolean;
    } | null;
    if (state && state.isRecording) isRecording = true;
  } catch {
    // main may not be ready yet — wait for the active-changed broadcast
  }
}

init().catch(() => {
  // never bubble preload errors into the page
});
