import { app, BrowserView, BrowserWindow, dialog, ipcMain, screen, session } from "electron";
import axios from "axios";
import * as path from "path";

import { attachBrowserGuard } from "./browser-guard";
import { registerIpcHandlers } from "./ipc-handlers";
import { ensurePackagedServicesReady, stopManagedServices } from "./service-manager";
import { SERVICE_URLS } from "./service-urls";
import { enableExamKeyboardLock, disableExamKeyboardLock } from "./keyboard-lock";
import {
  startProcessScanner,
  stopProcessScanner,
  detectVirtualMachine,
} from "./process-scanner";
import {
  initSupabaseLogger,
  shutdownSupabaseLogger,
  logViolation,
  logSessionEnd,
  updateSessionViolationCount,
} from "./supabase-logger";
import { shouldPersistViolation } from "./violation-policy";

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let examView: BrowserView | null = null;
let currentSession: { sessionId: string; userId: string } | null = null;
let isExamLocked = false; // True when kiosk + anti-cheat is fully active
let displayAddedHandler: (() => void) | null = null;

const SIDE_PANEL_WIDTH = 250; // Width of the right-side monitor panel

// ── Exam View (BrowserView for exam URL) ──────────────────────────────

function createExamView(examUrl: string, yOffset = 64): void {
  if (!mainWindow) {
    return;
  }

  if (examView) {
    mainWindow.removeBrowserView(examView);
    examView = null;
  }

  examView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.addBrowserView(examView);

  const [width, height] = mainWindow.getContentSize();
  const viewWidth = width - SIDE_PANEL_WIDTH;
  examView.setBounds({ x: 0, y: yOffset, width: viewWidth, height: height - yOffset });
  examView.setAutoResize({ width: true, height: true });

  attachBrowserGuard(examView, mainWindow, {
    onViolation: (type, metadata) => {
      mainWindow?.webContents.send("violation:detected", { type, metadata });
      if (currentSession) {
        void logViolationToBackend({
          event_type: type,
          severity: "high",
          metadata,
        });
      }
    },
  });

  void examView.webContents.loadURL(examUrl);
}

// ── Exam Session Lifecycle ────────────────────────────────────────────

function startExamSession(payload: {
  examUrl: string;
  sessionId: string;
  userId: string;
}) {
  currentSession = { sessionId: payload.sessionId, userId: payload.userId };
  // Start with a 52px offset for the compact pre-exam banner
  createExamView(payload.examUrl, 52);
  console.log("[Main] Exam session started (pre-exam phase)");
}

/**
 * Activate full lockdown: kiosk mode + keyboard lock + process scanner.
 * Called when pre-exam countdown finishes or student clicks "Bắt đầu bài thi".
 */
async function activateLockdown(): Promise<{ success: boolean; error?: string }> {
  if (!mainWindow || !currentSession) {
    return { success: false, error: "No active session" };
  }

  // ── Check multi-monitor ────────────────────────────────────────
  const displays = screen.getAllDisplays();
  if (displays.length > 1) {
    mainWindow.webContents.send("multi-monitor-detected");
    logViolation({
      session_id: currentSession.sessionId,
      event_type: "multi_monitor_blocked",
      severity: "critical",
      message: `Phát hiện ${displays.length} màn hình. Yêu cầu rút cáp.`,
    });
    return {
      success: false,
      error: `Phát hiện ${displays.length} màn hình. Vui lòng rút cáp màn hình phụ.`,
    };
  }

  // ── Check VM ───────────────────────────────────────────────────
  /*
  const vmResult = await detectVirtualMachine();
  if (vmResult.isVM) {
    mainWindow.webContents.send("vm-detected", vmResult.indicators);
    logViolation({
      session_id: currentSession.sessionId,
      event_type: "vm_detected",
      severity: "critical",
      message: `Máy ảo detected: ${vmResult.indicators.join(", ")}`,
    });
    return {
      success: false,
      error: "Phát hiện máy ảo. Không thể thi trên máy ảo.",
    };
  }
  */

  // ── Activate Kiosk ────────────────────────────────────────────
  enterKioskMode();

  // ── Keyboard Lock ─────────────────────────────────────────────
  enableExamKeyboardLock(mainWindow, (shortcut) => {
    if (currentSession) {
      logViolation({
        session_id: currentSession.sessionId,
        event_type: "blocked_shortcut",
        severity: "medium",
        message: `Phím tắt bị chặn: ${shortcut}`,
      });
    }
  });

  // ── Process Scanner (every 60s) ────────────────────────────────
  startProcessScanner((processName) => {
    mainWindow?.webContents.send("cheating-alert", {
      type: "process_killed",
      detail: `Đã tắt ứng dụng bị cấm: ${processName}`,
    });
    if (currentSession) {
      logViolation({
        session_id: currentSession.sessionId,
        event_type: "blacklisted_process",
        severity: "high",
        message: `Ứng dụng bị cấm bị kill: ${processName}`,
        metadata: { process_name: processName },
      });
    }
  }, 60_000);

  // ── Monitor display changes during exam ─────────────────────────
  displayAddedHandler = () => {
    const newDisplays = screen.getAllDisplays();
    if (newDisplays.length > 1 && currentSession) {
      console.log("[Main] Display added during exam – auto-submitting");
      mainWindow?.webContents.send("exam:auto-submit", "multi_monitor_connected");
      logViolation({
        session_id: currentSession.sessionId,
        event_type: "multi_monitor_connected",
        severity: "critical",
        message: "Thêm màn hình giữa chừng – tự động nộp bài",
      });
    }
  };
  screen.on("display-added", displayAddedHandler);

  isExamLocked = true;
  console.log("[Main] Full lockdown ACTIVATED");
  return { success: true };
}

function stopExamSession() {
  // ── Deactivate lockdown ─────────────────────────────────────────
  if (isExamLocked) {
    exitKioskMode();
    disableExamKeyboardLock();
    stopProcessScanner();

    if (displayAddedHandler) {
      screen.removeListener("display-added", displayAddedHandler);
      displayAddedHandler = null;
    }

    isExamLocked = false;
  }

  currentSession = null;
  if (examView && mainWindow) {
    mainWindow.removeBrowserView(examView);
    examView = null;
  }

  console.log("[Main] Exam session stopped");
}

// ── Kiosk Mode ────────────────────────────────────────────────────────

function enterKioskMode(): void {
  if (!mainWindow) return;

  mainWindow.setKiosk(true);
  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setMinimizable(false);
  mainWindow.setClosable(false);
  mainWindow.setSkipTaskbar(true);

  console.log("[Main] Kiosk mode ENABLED");
}

function exitKioskMode(): void {
  if (!mainWindow) return;

  mainWindow.setKiosk(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimizable(true);
  mainWindow.setClosable(true);
  mainWindow.setSkipTaskbar(false);

  console.log("[Main] Kiosk mode DISABLED");
}

// ── Dev Diagnostics ───────────────────────────────────────────────────

function attachDevDiagnostics(window: BrowserWindow) {
  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error("[Renderer] did-fail-load", {
        errorCode,
        errorDescription,
        validatedURL,
      });
    }
  );

  window.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      console.log("[Renderer console]", {
        level,
        message,
        line,
        sourceId,
      });
    }
  );

  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("[Renderer] render-process-gone", details);
  });

  window.webContents.on("did-finish-load", () => {
    console.log("[Renderer] did-finish-load", window.webContents.getURL());
  });
}

// ── Main Window ───────────────────────────────────────────────────────

function createWindow(): void {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width,
    height,
    fullscreen: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox must be false so the renderer can call getUserMedia
      sandbox: false,
      webSecurity: true,
    },
  });

  const isDev = !app.isPackaged;
  if (isDev) {
    void mainWindow.loadURL("http://localhost:3000");
    attachDevDiagnostics(mainWindow);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  // ── Focus / Blur events ─────────────────────────────────────────
  mainWindow.on("blur", () => {
    if (currentSession && isExamLocked) {
      mainWindow?.webContents.send("window:focuslost");
      void logViolationToBackend({
        event_type: "app_focus_lost",
        severity: "medium",
        metadata: {},
      });
      logViolation({
        session_id: currentSession.sessionId,
        event_type: "app_focus_lost",
        severity: "medium",
        message: "Thí sinh rời khỏi cửa sổ thi",
      });

      // Auto re-focus after short delay
      setTimeout(() => {
        if (mainWindow && isExamLocked) {
          mainWindow.focus();
          mainWindow.setAlwaysOnTop(true, "screen-saver");
        }
      }, 200);
    }
  });

  mainWindow.on("focus", () => {
    if (currentSession && isExamLocked) {
      mainWindow?.webContents.send("window:focusregained");
    }
  });

  mainWindow.on("leave-full-screen", () => {
    mainWindow?.webContents.send("window:fullscreen", false);
    if (currentSession && isExamLocked) {
      // Re-enforce kiosk mode
      mainWindow?.setKiosk(true);
      void logViolationToBackend({
        event_type: "fullscreen_exit",
        severity: "high",
        metadata: {},
      });
    }
  });

  mainWindow.on("enter-full-screen", () => {
    mainWindow?.webContents.send("window:fullscreen", true);
  });

  mainWindow.on("close", (event) => {
    if (currentSession && isExamLocked) {
      event.preventDefault();
      void logViolationToBackend({
        event_type: "app_close_attempt",
        severity: "high",
        metadata: {},
      });
    }
  });
}

// ── Backend Violation Logger ──────────────────────────────────────────

async function logViolationToBackend(partial: {
  event_type: string;
  severity: string;
  metadata: Record<string, unknown>;
}) {
  if (!currentSession) {
    return;
  }

  if (!shouldPersistViolation(partial.event_type, partial.severity, partial.metadata)) {
    return;
  }

  try {
    await axios.post(`${SERVICE_URLS.backend}/violations/`, {
      session_id: currentSession.sessionId,
      user_id: currentSession.userId,
      ...partial,
    });
  } catch (error) {
    console.error("[Main] Failed to log violation to backend:", error);
  }
}

// ── App Bootstrap ─────────────────────────────────────────────────────

async function bootstrapApp() {
  // Initialize Supabase logger (loads crash-recovery queue)
  initSupabaseLogger();

  try {
    await ensurePackagedServicesReady();
  } catch (error: any) {
    dialog.showErrorBox(
      "SecureExam startup failed",
      error?.message || "Khong the khoi dong backend va AI service."
    );
    app.quit();
    return;
  }

  registerIpcHandlers({
    backendUrl: SERVICE_URLS.backend,
    aiUrl: SERVICE_URLS.ai,
    onExamStarted: startExamSession,
    onExamEnded: stopExamSession,
    onExamLockdown: async () => {
      const result = await activateLockdown();
      if (!result.success) {
        mainWindow?.webContents.send("cheating-alert", {
          type: "lockdown_failed",
          detail: result.error || "Không thể kích hoạt chế độ thi",
        });
      } else {
        // Expand view for active exam (toolbar 64px, side panel 250px)
        if (examView && mainWindow) {
          const [width, height] = mainWindow.getContentSize();
          examView.setBounds({ x: 0, y: 64, width: width - SIDE_PANEL_WIDTH, height: height - 64 });
        }
      }
      return result;
    },
    onExamCancelled: (sessionId, reason) => {
      stopExamSession();
    },
  });

  // Handle manual view bounds updates
  ipcMain.handle("view:update-bounds", (_event: any, y: number) => {
    if (examView && mainWindow) {
      const [width, height] = mainWindow.getContentSize();
      examView.setBounds({ x: 0, y, width: width - SIDE_PANEL_WIDTH, height: height - y });
    }
    return { success: true };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

app.whenReady().then(() => {
  // Grant camera and microphone permissions automatically.
  // Without this, Electron silently blocks getUserMedia in the renderer.
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      const allowed = ["media", "camera", "microphone", "audioCapture", "videoCapture"];
      callback(allowed.includes(permission));
    }
  );

  // Also handle permission checks (Electron 20+)
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => {
      const allowed = ["media", "camera", "microphone", "audioCapture", "videoCapture"];
      return allowed.includes(permission);
    }
  );

  void bootstrapApp();
});

app.on("before-quit", () => {
  stopExamSession();
  stopManagedServices();
  shutdownSupabaseLogger();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
