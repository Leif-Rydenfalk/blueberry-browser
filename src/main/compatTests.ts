/**
 * Browser compatibility tests.
 *
 * Unlike the agent suite in testTasks.ts, these are deterministic page-level
 * checks: open a hidden BrowserWindow, navigate to a URL, capture a snapshot
 * of the rendered page, and assert on it. No LLM, no agent loop.
 *
 * Purpose: catch regressions where a site refuses to load the browser —
 * typically because of client-sniffing on the user agent (WhatsApp, some
 * Google properties, Discord). The first test pins the WhatsApp Web fix:
 * sanitized `app.userAgentFallback` must keep WhatsApp from showing the
 * "Update Google Chrome" page.
 *
 * Run via the same harness:
 *   pnpm test                          all agent + compat tests
 *   pnpm test --filter=whatsapp        compat tests matching "whatsapp"
 *   pnpm test --compat-only            skip the agent suite entirely
 */

import { BrowserWindow } from "electron";
import type { TestValidation } from "./testTasks";

export interface PageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly bodyText: string;
  readonly hasCanvas: boolean;
  readonly canvasSize: string | null;
  readonly userAgent: string;
}

export interface CompatTest {
  readonly name: string;
  readonly url: string;
  readonly waitMs: number;
  readonly timeoutMs: number;
  readonly validate: (snapshot: PageSnapshot) => TestValidation;
}

export interface CompatResult {
  readonly test: CompatTest;
  readonly passed: boolean;
  readonly durationMs: number;
  readonly snapshot?: PageSnapshot;
  readonly validation?: TestValidation;
  readonly error?: string;
}

function contains(text: string, ...keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export const COMPAT_TESTS: readonly CompatTest[] = [
  {
    name: "whatsapp-web-loads-qr",
    url: "https://web.whatsapp.com/",
    waitMs: 15_000,
    timeoutMs: 30_000,
    validate: (snap) => {
      const blocked = contains(
        snap.bodyText,
        "WhatsApp works with Google Chrome",
        "update Google Chrome",
        "use Mozilla Firefox",
      );
      if (blocked) {
        return {
          pass: false,
          reason: `WhatsApp showed unsupported-browser page — UA sanitization likely regressed. UA was: ${snap.userAgent}`,
        };
      }
      if (snap.userAgent.includes("Electron")) {
        return {
          pass: false,
          reason: `UA still contains "Electron" token (should be stripped in index.ts): ${snap.userAgent}`,
        };
      }
      const reachedLogin = contains(
        snap.bodyText,
        "Scan to log in",
        "Link with phone number",
        "Linked devices",
      );
      const hasQrCanvas = snap.hasCanvas;
      if (!reachedLogin && !hasQrCanvas) {
        return {
          pass: false,
          reason: `WhatsApp did not reach the login screen — no QR canvas and no expected text. body[0..200]: ${snap.bodyText.substring(0, 200)}`,
        };
      }
      return { pass: true, reason: "WhatsApp QR login screen rendered" };
    },
  },
];

export async function runCompatTest(
  test: CompatTest,
): Promise<CompatResult> {
  const startMs = Date.now();
  let window: BrowserWindow | null = null;

  try {
    window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    const loadPromise = window.webContents.loadURL(test.url);
    const loadTimeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`loadURL timed out after ${test.timeoutMs}ms`)),
        test.timeoutMs,
      );
    });
    await Promise.race([loadPromise, loadTimeout]);

    await new Promise((r) => setTimeout(r, test.waitMs));

    const snapshot = (await window.webContents.executeJavaScript(`
      (function() {
        var canvas = document.querySelector('canvas');
        return {
          url: location.href,
          title: document.title,
          bodyText: document.body ? document.body.innerText : '',
          hasCanvas: !!canvas,
          canvasSize: canvas ? canvas.width + 'x' + canvas.height : null,
          userAgent: navigator.userAgent
        };
      })()
    `)) as PageSnapshot;

    const validation = test.validate(snapshot);
    return {
      test,
      passed: validation.pass,
      durationMs: Date.now() - startMs,
      snapshot,
      validation,
    };
  } catch (err) {
    return {
      test,
      passed: false,
      durationMs: Date.now() - startMs,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (window && !window.isDestroyed()) {
      window.close();
    }
  }
}
