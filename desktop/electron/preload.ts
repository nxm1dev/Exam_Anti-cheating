import { contextBridge, ipcRenderer } from "electron";

export interface ExamSessionConfig {
  userId: string;
  examUrl: string;
  referenceEmbeddingB64?: string;
}

export interface ViolationPayload {
  sessionId: string;
  userId: string;
  eventType: string;
  severity: string;
  metadata: Record<string, unknown>;
}

contextBridge.exposeInMainWorld("electronAPI", {
  startExam: (config: ExamSessionConfig) => ipcRenderer.invoke("exam:start", config),
  endExam: (sessionId: string) => ipcRenderer.invoke("exam:end", sessionId),
  saveEvidenceLocal: (data: { sessionId: string; violationId: string; videoBase64: string }) => 
    ipcRenderer.invoke("evidence:save-local", data),
  createUser: (payload: { email: string; full_name: string; role: string }) =>
    ipcRenderer.invoke("user:create", payload),
  getUser: (userId: string) => ipcRenderer.invoke("user:get", userId),
  registerFace: (userId: string, frameB64: string) =>
    ipcRenderer.invoke("user:registerFace", userId, frameB64),
  logViolation: (violation: ViolationPayload) => ipcRenderer.invoke("violation:log", violation),
  logViolationsBatch: (items: unknown[]) => ipcRenderer.invoke("violations:batch", items),
  analyzeFrame: (frameB64: string, referenceEmbeddingB64?: string) =>
    ipcRenderer.invoke("ai:analyzeFrame", frameB64, referenceEmbeddingB64),
  analyzeAudio: (pcmB64: string, sessionId: string) =>
    ipcRenderer.invoke("ai:analyzeAudio", pcmB64, sessionId),
  getReport: (sessionId: string) => ipcRenderer.invoke("report:get", sessionId),
  onFocusLost: (cb: () => void) => {
    ipcRenderer.on("window:focuslost", cb);
    return () => ipcRenderer.removeListener("window:focuslost", cb);
  },
  onFullscreenChange: (cb: (isFullscreen: boolean) => void) => {
    const listener = (_event: unknown, value: boolean) => cb(value);
    ipcRenderer.on("window:fullscreen", listener);
    return () => ipcRenderer.removeListener("window:fullscreen", listener);
  },
});
