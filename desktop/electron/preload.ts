import { contextBridge, ipcRenderer } from "electron";

export interface ExamSessionConfig {
  userId: string;
  examUrl: string;
  referenceEmbeddingB64?: string;
}

export interface ViolationPayload {
  id?: string;
  sessionId: string;
  userId: string;
  eventType: string;
  severity: string;
  message?: string;
  metadata: Record<string, unknown>;
}

contextBridge.exposeInMainWorld("electronAPI", {
  // ── Exam lifecycle ──────────────────────────────────────────────
  startExam: (config: ExamSessionConfig) => ipcRenderer.invoke("exam:start", config),
  endExam: (sessionId: string, violationCounts?: Record<string, number>) =>
    ipcRenderer.invoke("exam:end", sessionId, violationCounts),
  lockdownExam: () => ipcRenderer.invoke("exam:lockdown"),
  updateViewBounds: (y: number) => ipcRenderer.invoke("view:update-bounds", y),
  cancelExam: (sessionId: string, reason: string) =>
    ipcRenderer.invoke("exam:cancel", sessionId, reason),

  // ── User management ─────────────────────────────────────────────
  createUser: (payload: { email: string; full_name: string; role: string }) =>
    ipcRenderer.invoke("user:create", payload),
  getUser: (userId: string) => ipcRenderer.invoke("user:get", userId),
  registerFace: (userId: string, frameB64: string) =>
    ipcRenderer.invoke("user:registerFace", userId, frameB64),

  // ── Violations ──────────────────────────────────────────────────
  logViolation: (violation: ViolationPayload) => ipcRenderer.invoke("violation:log", violation),
  logViolationsBatch: (items: unknown[]) => ipcRenderer.invoke("violations:batch", items),

  // ── AI analysis ─────────────────────────────────────────────────
  analyzeFrame: (frameB64: string, referenceEmbeddingB64?: string) =>
    ipcRenderer.invoke("ai:analyzeFrame", frameB64, referenceEmbeddingB64),
  analyzeAudio: (pcmB64: string, sessionId: string) =>
    ipcRenderer.invoke("ai:analyzeAudio", pcmB64, sessionId),

  // ── Report ──────────────────────────────────────────────────────
  getReport: (sessionId: string) => ipcRenderer.invoke("report:get", sessionId),

  // ── Video upload ────────────────────────────────────────────────
  uploadViolationVideo: (sessionId: string, violationId: string, videoBase64: string) =>
    ipcRenderer.invoke("violation:uploadVideo", sessionId, violationId, videoBase64),

  // ── Event listeners (Main → Renderer) ───────────────────────────
  onFocusLost: (cb: () => void) => {
    ipcRenderer.on("window:focuslost", cb);
    return () => ipcRenderer.removeListener("window:focuslost", cb);
  },
  onFocusRegained: (cb: () => void) => {
    ipcRenderer.on("window:focusregained", cb);
    return () => ipcRenderer.removeListener("window:focusregained", cb);
  },
  onFullscreenChange: (cb: (isFullscreen: boolean) => void) => {
    const listener = (_event: unknown, value: boolean) => cb(value);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.removeListener("window:fullscreen", listener);
  },
  onCheatingAlert: (cb: (data: { type: string; detail: string }) => void) => {
    const listener = (_event: unknown, data: any) => cb(data);
    ipcRenderer.on("cheating-alert", listener);
    return () => ipcRenderer.removeListener("cheating-alert", listener);
  },
  onViolationDetected: (cb: (data: any) => void) => {
    const listener = (_event: unknown, data: any) => cb(data);
    ipcRenderer.on("violation:detected", listener);
    return () => ipcRenderer.removeListener("violation:detected", listener);
  },
  onMultiMonitorDetected: (cb: () => void) => {
    ipcRenderer.on("multi-monitor-detected", cb);
    return () => ipcRenderer.removeListener("multi-monitor-detected", cb);
  },
  onVMDetected: (cb: (indicators: string[]) => void) => {
    const listener = (_event: unknown, indicators: string[]) => cb(indicators);
    ipcRenderer.on("vm-detected", listener);
    return () => ipcRenderer.removeListener("vm-detected", listener);
  },
  onExamAutoSubmit: (cb: (reason: string) => void) => {
    const listener = (_event: unknown, reason: string) => cb(reason);
    ipcRenderer.on("exam:auto-submit", listener);
    return () => ipcRenderer.removeListener("exam:auto-submit", listener);
  },
});
