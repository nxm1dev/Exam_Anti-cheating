import { ipcMain } from "electron";
import axios from "axios";
import crypto from "crypto";

import { SERVICE_URLS } from "./service-urls";
import {
  logSessionStart,
  logSessionEnd,
  logExamSubmission,
  logViolation,
  queueVideoUpload,
} from "./supabase-logger";

type ExamStartConfig = {
  userId: string;
  examUrl: string;
};

type RegisterHandlersOptions = {
  backendUrl?: string;
  aiUrl?: string;
  onExamStarted?: (payload: {
    examUrl: string;
    sessionId: string;
    userId: string;
  }) => void;
  onExamEnded?: () => void;
  onExamLockdown?: () => Promise<{ success: boolean; error?: string }>;
  onExamCancelled?: (sessionId: string, reason: string) => void;
};

export function registerIpcHandlers(options: RegisterHandlersOptions = {}): void {
  const backendUrl = options.backendUrl ?? SERVICE_URLS.backend;
  const aiUrl = options.aiUrl ?? SERVICE_URLS.ai;

  // ── Exam Start ─────────────────────────────────────────────────
  ipcMain.handle("exam:start", async (_event, config: ExamStartConfig) => {
    const { data } = await axios.post(`${backendUrl}/sessions/`, {
      user_id: config.userId,
      exam_url: config.examUrl,
    });

    // Log session start to Supabase
    void logSessionStart({
      session_id: data.id,
      user_id: config.userId,
    });

    options.onExamStarted?.({
      examUrl: config.examUrl,
      sessionId: data.id,
      userId: config.userId,
    });

    return data;
  });

  // ── Exam Lockdown (kiosk + anti-cheat activation) ─────────────
  ipcMain.handle("exam:lockdown", async () => {
    if (options.onExamLockdown) {
      const result = await options.onExamLockdown();
      console.log("[IPC] exam:lockdown result:", result);
      return result;
    }
    return { success: true };
  });

  // ── Exam End ───────────────────────────────────────────────────
  ipcMain.handle("exam:end", async (_event, sessionId: string, violationCounts?: {
    total_violations?: number;
    critical_count?: number;
    high_count?: number;
    medium_count?: number;
    low_count?: number;
  }) => {
    const { data } = await axios.post(`${backendUrl}/sessions/${sessionId}/end`, {
      status: "completed",
      ...(violationCounts || {}),
    });

    await axios
      .post(`${aiUrl}/analyze/audio/clear`, { session_id: sessionId })
      .catch(() => undefined);

    // Log submission + session end to Supabase (awaited for reliability)
    try {
      await logExamSubmission(sessionId);
      await logSessionEnd(sessionId, "completed");
    } catch (err: any) {
      console.error("[IPC] Supabase logging failed (non-blocking):", err.message);
    }

    options.onExamEnded?.();
    return data;
  });

  // ── Exam Cancel (auto-cancel due to violations) ────────────────
  ipcMain.handle("exam:cancel", async (_event, sessionId: string, reason: string) => {
    try {
      await axios.post(`${backendUrl}/sessions/${sessionId}/end`, {
        status: "cancelled",
      });
    } catch {
      // Backend may not support cancel status – continue anyway
    }

    // Log cancel to Supabase
    void logSessionEnd(sessionId, "cancelled", reason);
    logViolation({
      session_id: sessionId,
      event_type: "exam_cancelled",
      severity: "critical",
      message: reason,
    });

    options.onExamCancelled?.(sessionId, reason);
    return { success: true };
  });

  // ── User Management ────────────────────────────────────────────
  ipcMain.handle("user:create", async (_event, payload) => {
    try {
      const { data } = await axios.post(`${backendUrl}/users/`, payload);
      return data;
    } catch (err: any) {
      // 409 = email already registered → return the existing user instead of failing
      if (err?.response?.status === 409) {
        const { data } = await axios.get(
          `${backendUrl}/users/by-email/${encodeURIComponent(payload.email)}`
        );
        return data;
      }
      throw err;
    }
  });

  ipcMain.handle("user:get", async (_event, userId: string) => {
    const { data } = await axios.get(`${backendUrl}/users/${userId}`);
    return data;
  });

  ipcMain.handle("user:registerFace", async (_event, userId: string, frameB64: string) => {
    // Validate frame before sending to AI service
    if (!frameB64 || frameB64.length < 100) {
      throw new Error("Du lieu anh khong hop le (frame rong). Camera co the chua san sang.");
    }
    console.log(`[registerFace] Frame size: ${frameB64.length} bytes (base64)`);

    const { data: faceData } = await axios.post(`${aiUrl}/analyze/face/`, {
      frame_b64: frameB64,
    });

    console.log(`[registerFace] AI response: face_detected=${faceData.face_detected}, embedding=${!!faceData.embedding_b64}`);

    if (!faceData.face_detected) {
      throw new Error(
        "Khong phat hien khuon mat. Vui long nhin thang vao camera va dam bao du anh sang."
      );
    }
    if (!faceData.embedding_b64) {
      throw new Error(
        "Khong the trich xuat dac trung khuon mat. Vui long thu lai."
      );
    }

    const { data } = await axios.put(`${backendUrl}/users/${userId}/face`, {
      face_embedding: faceData.embedding_b64,
    });
    return data;
  });

  // ── Violations ─────────────────────────────────────────────────
  ipcMain.handle("violations:batch", async (_event, items) => {
    // Log to Supabase FIRST (always, regardless of backend success)
    for (const item of items) {
      logViolation({
        id: item.id,
        session_id: item.session_id,
        event_type: item.event_type,
        severity: item.severity,
        message: item.message,
        metadata: item.metadata,
      });
    }

    // Then try backend (may fail if backend is down)
    try {
      const { data } = await axios.post(`${backendUrl}/violations/batch`, items);
      return data;
    } catch (err: any) {
      console.error("[IPC] violations:batch backend error (Supabase logged OK):", err.message);
      // Return a stub so renderer doesn't crash
      return items.map((item: any) => ({ ...item, id: crypto.randomUUID() }));
    }
  });

  ipcMain.handle("violation:log", async (_event, violation) => {
    // Log to Supabase FIRST
    logViolation({
      id: violation.id,
      session_id: violation.session_id,
      event_type: violation.event_type,
      severity: violation.severity,
      message: violation.message,
      metadata: violation.metadata,
    });

    // Then try backend
    try {
      const { data } = await axios.post(`${backendUrl}/violations/`, violation);
      return data;
    } catch (err: any) {
      console.error("[IPC] violation:log backend error (Supabase logged OK):", err.message);
      return { ...violation, id: crypto.randomUUID() };
    }
  });

  // ── AI Analysis ────────────────────────────────────────────────
  ipcMain.handle("ai:analyzeFrame", async (_event, frameB64: string, referenceEmbeddingB64?: string) => {
    const { data } = await axios.post(`${aiUrl}/analyze/face/`, {
      frame_b64: frameB64,
      reference_embedding_b64: referenceEmbeddingB64 || null,
    });
    return data;
  });

  ipcMain.handle("ai:analyzeAudio", async (_event, pcmB64: string, sessionId: string) => {
    const { data } = await axios.post(`${aiUrl}/analyze/audio/`, {
      pcm_b64: pcmB64,
      session_id: sessionId,
    });
    return data;
  });

  // ── Report ─────────────────────────────────────────────────────
  ipcMain.handle("report:get", async (_event, sessionId: string) => {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 1500;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data } = await axios.get(`${backendUrl}/reports/${sessionId}`);
        return data;
      } catch (err: any) {
        const status = err?.response?.status;
        console.error(`[IPC] report:get attempt ${attempt}/${MAX_RETRIES} failed (HTTP ${status}):`, err.message);

        if (attempt < MAX_RETRIES && (status === 500 || status === 502 || !status)) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * attempt));
          continue;
        }
        throw err;
      }
    }
  });

  // ── Video Upload ───────────────────────────────────────────────
  ipcMain.handle(
    "violation:uploadVideo",
    async (_event, sessionId: string, violationId: string, videoBase64: string) => {
      const buffer = Buffer.from(videoBase64, "base64");
      queueVideoUpload(sessionId, violationId, buffer);
      return { success: true };
    }
  );
}
