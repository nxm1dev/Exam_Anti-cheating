/**
 * electron/browser-guard.ts
 * ──────────────────────────
 * URL whitelist enforcement for the BrowserView that hosts the exam page.
 *
 * Responsibilities:
 * - Validate URLs against the whitelist (glob patterns from config)
 * - Block navigation to disallowed URLs
 * - Block new-window / popup creation attempts
 * - Emit violation events back to the main process for logging
 */

import { session, BrowserView, BrowserWindow, WebContents } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

// ── Config loading ──────────────────────────────────────────────────
interface WhitelistConfig {
  whitelist: string[];
  resource_domains: string[];
  navigation: {
    block_new_tab: boolean;
    block_popup: boolean;
    block_external_links: boolean;
    block_right_click: boolean;
    block_devtools: boolean;
  };
}

function loadWhitelistConfig(): WhitelistConfig {
  // Try multiple candidate paths to support both dev and packaged modes.
  // Dev mode:  __dirname = desktop/dist/electron/ → need ../../../config/
  // Packaged:  __dirname = resources/app/dist/electron/ → need ../../config/
  const candidates = [
    path.resolve(__dirname, "../../config/whitelist.yaml"),
    path.resolve(__dirname, "../../../config/whitelist.yaml"),
    path.resolve(__dirname, "../../../../config/whitelist.yaml"),
  ];

  for (const configPath of candidates) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      console.log(`[BrowserGuard] Loaded whitelist config from: ${configPath}`);
      return yaml.load(raw) as WhitelistConfig;
    } catch {
      // Try next candidate
    }
  }

  console.error("[BrowserGuard] Cannot load whitelist config from any path, using empty list");
  console.error("[BrowserGuard] Tried:", candidates.join(", "));
  return {
    whitelist: [],
    resource_domains: [],
    navigation: {
      block_new_tab: true,
      block_popup: true,
      block_external_links: true,
      block_right_click: true,
      block_devtools: true,
    },
  };
}

// ── Glob pattern matching ───────────────────────────────────────────
/**
 * Match a URL against a glob pattern.
 * Supports simple * wildcards. Example: "https://exam.edu/*"
 */
function matchGlob(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(url);
}

export function isUrlAllowed(url: string, config: WhitelistConfig): boolean {
  // Always allow local resources
  if (url.startsWith("file://") || url.startsWith("about:")) return true;

  // Check resource domains (for fonts, CDN, etc.)
  try {
    const parsed = new URL(url);
    if (config.resource_domains.some((d) => parsed.hostname.endsWith(d))) {
      return true;
    }
  } catch {
    return false;
  }

  // Check whitelist patterns
  return config.whitelist.some((pattern) => matchGlob(url, pattern));
}

// ── BrowserView guard setup ─────────────────────────────────────────
export interface GuardEvents {
  onViolation: (type: string, metadata: Record<string, unknown>) => void;
}

/**
 * Attach all navigation and popup guards to a BrowserView's webContents.
 */
export function attachBrowserGuard(
  view: BrowserView,
  win: BrowserWindow,
  events: GuardEvents
): void {
  const config = loadWhitelistConfig();
  const wc: WebContents = view.webContents;

  // ── Block navigation to non-whitelisted URLs ──────────────────────
  wc.on("will-navigate", (evt, url) => {
    if (!isUrlAllowed(url, config)) {
      evt.preventDefault();
      events.onViolation("url_blocked", { attempted_url: url });
      console.warn(`[BrowserGuard] Blocked navigation to: ${url}`);
    }
  });

  // Also catches in-page navigation (SPA hash/history changes)
  wc.on("did-navigate-in-page", (_evt, url) => {
    if (!isUrlAllowed(url, config)) {
      events.onViolation("url_blocked", { attempted_url: url });
    }
  });

  // ── Block new windows / popups ────────────────────────────────────
  wc.setWindowOpenHandler(({ url }) => {
    if (config.navigation.block_popup || config.navigation.block_new_tab) {
      events.onViolation("popup_attempt", { attempted_url: url });
      console.warn(`[BrowserGuard] Blocked popup/new tab: ${url}`);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  // ── Block DevTools ────────────────────────────────────────────────
  if (config.navigation.block_devtools) {
    wc.on("devtools-opened", () => {
      wc.closeDevTools();
      events.onViolation("devtools_opened", {});
    });
  }

  // ── Inject page-level guards via JavaScript ───────────────────────
  wc.on("dom-ready", () => {
    injectPageGuards(wc, config);
  });
}

/**
 * JavaScript injected into the exam page to:
 * - Block right-click context menu
 * - Override window.open
 * - Block common keyboard shortcuts (Ctrl+T, Ctrl+W, Alt+F4, etc.)
 */
function injectPageGuards(wc: WebContents, config: WhitelistConfig): void {
  const script = `
    (function() {
      // Block right-click
      ${config.navigation.block_right_click ? "document.addEventListener('contextmenu', e => e.preventDefault());" : ""}

      // Override window.open
      ${config.navigation.block_popup ? "window.open = function() { return null; };" : ""}

      // Block dangerous keyboard shortcuts
      document.addEventListener('keydown', function(e) {
        const isCtrl = e.ctrlKey || e.metaKey;
        // Ctrl+T (new tab), Ctrl+W (close), Ctrl+N (new window), Alt+F4
        if (
          (isCtrl && ['t','w','n'].includes(e.key.toLowerCase())) ||
          (e.altKey && e.key === 'F4') ||
          e.key === 'F11'   // fullscreen toggle
        ) {
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
    })();
  `;

  wc.executeJavaScript(script).catch((e) =>
    console.warn("[BrowserGuard] Script injection error:", e)
  );
}
