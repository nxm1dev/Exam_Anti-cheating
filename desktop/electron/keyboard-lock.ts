/**
 * electron/keyboard-lock.ts
 * ──────────────────────────
 * Global shortcut registration to block cheating keyboard shortcuts
 * during an active exam session.
 *
 * Blocked shortcuts:
 *   - F12, Ctrl+Shift+I/J (DevTools)
 *   - Ctrl+C/V/X (Copy/Paste/Cut)
 *   - PrintScreen (Screenshot)
 *   - Alt+F4 (Force close)
 *   - F11 (Fullscreen toggle)
 *   - Ctrl+W/N/T (Close/New window/tab)
 */

import { BrowserWindow, globalShortcut } from "electron";

type AlertCallback = (shortcut: string) => void;

let onAlertCallback: AlertCallback | null = null;
let isLocked = false;

const BLOCKED_SHORTCUTS = [
  // DevTools
  "F12",
  "CommandOrControl+Shift+I",
  "CommandOrControl+Shift+J",
  "CommandOrControl+Shift+C",

  // Copy / Paste / Cut
  "CommandOrControl+C",
  "CommandOrControl+V",
  "CommandOrControl+X",

  // Screenshot
  "PrintScreen",

  // Close / Quit
  "Alt+F4",
  "CommandOrControl+Q",
  "CommandOrControl+W",

  // New window / tab
  "CommandOrControl+N",
  "CommandOrControl+T",

  // Fullscreen toggle
  "F11",

  // Refresh (prevent reload to bypass lockdown)
  "CommandOrControl+R",
  "CommandOrControl+Shift+R",
  "F5",
];

/**
 * Register global shortcuts to block cheating key combos.
 * Each intercepted shortcut fires the onAlert callback.
 */
export function enableExamKeyboardLock(
  window: BrowserWindow,
  onAlert: AlertCallback
): void {
  if (isLocked) return;

  onAlertCallback = onAlert;
  isLocked = true;

  for (const accelerator of BLOCKED_SHORTCUTS) {
    try {
      globalShortcut.register(accelerator, () => {
        console.log(`[KeyboardLock] Blocked: ${accelerator}`);
        onAlertCallback?.(accelerator);
        window.webContents.send("cheating-alert", {
          type: "blocked_shortcut",
          detail: `Phím tắt bị chặn: ${accelerator}`,
        });
      });
    } catch (err) {
      // Some shortcuts may not be registerable on all platforms
      console.warn(`[KeyboardLock] Could not register ${accelerator}:`, err);
    }
  }

  console.log("[KeyboardLock] Exam keyboard lock ENABLED");
}

/**
 * Unregister all global shortcuts, restoring normal keyboard behavior.
 */
export function disableExamKeyboardLock(): void {
  if (!isLocked) return;

  globalShortcut.unregisterAll();
  onAlertCallback = null;
  isLocked = false;

  console.log("[KeyboardLock] Exam keyboard lock DISABLED");
}
