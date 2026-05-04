import { ipcMain } from "electron";
import axios from "axios";

import { SERVICE_URLS } from "./service-urls";

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
};

export function registerIpcHandlers(options: RegisterHandlersOptions = {}): void {
  const backendUrl = options.backendUrl ?? SERVICE_URLS.backend;
  const aiUrl = options.aiUrl ?? SERVICE_URLS.ai;

  ipcMain.handle("exam:start", async (_event, config: ExamStartConfig) => {
    const { data } = await axios.post(`${backendUrl}/sessions/`, {
      user_id: config.userId,
      exam_url: config.examUrl,
    });

    options.onExamStarted?.({
      examUrl: config.examUrl,
      sessionId: data.id,
      userId: config.userId,
    });

    return data;
  });

  ipcMain.handle("exam:end", async (_event, sessionId: string) => {
    const { data } = await axios.post(`${backendUrl}/sessions/${sessionId}/end`, {
      status: "completed",
    });

    await axios
      .post(`${aiUrl}/analyze/audio/clear`, { session_id: sessionId })
      .catch(() => undefined);

    options.onExamEnded?.();
    return data;
  });

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

  ipcMain.handle("violations:batch", async (_event, items) => {
    const { data } = await axios.post(`${backendUrl}/violations/batch`, items);
    return data;
  });

  ipcMain.handle("violation:log", async (_event, violation) => {
    const { data } = await axios.post(`${backendUrl}/violations/`, violation);
    return data;
  });

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

  ipcMain.handle("report:get", async (_event, sessionId: string) => {
    const { data } = await axios.get(`${backendUrl}/reports/${sessionId}`);
    return data;
  });
}
import * as fs from "fs";
import * as path from "path";

ipcMain.handle("evidence:save-local", async (_event, { sessionId, violationId, videoBase64 }) => {
  try {
    const dir = path.join(process.cwd(), "violations", sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const filePath = path.join(dir, `${violationId}.webm`);
    const buffer = Buffer.from(videoBase64, "base64");
    fs.writeFileSync(filePath, buffer);
    
    return { success: true, path: filePath };
  } catch (error) {
    console.error("Failed to save evidence locally", error);
    return { success: false, error: String(error) };
  }
});
