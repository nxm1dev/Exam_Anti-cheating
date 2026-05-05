/**
 * src/hooks/useRollingBuffer.ts
 * ──────────────────────────────
 * Ring buffer for camera + microphone recording.
 * Continuously records at 480p 15FPS + full audio.
 * When a violation is triggered, captures a ~10s clip (5s before + 5s after).
 */

import { useRef, useCallback, useEffect, useState } from "react";

const api = (window as any).electronAPI;

interface UseRollingBufferOptions {
  sessionId: string;
  /** Seconds of pre-violation footage to keep in memory */
  bufferDuration?: number;
  /** Chunk interval in ms (default 2000) */
  chunkIntervalMs?: number;
}

interface RollingBufferAPI {
  /** Whether the buffer is actively recording */
  isRecording: boolean;
  /** Start continuous background recording */
  startRecording: (stream: MediaStream) => void;
  /** Stop recording and cleanup */
  stopRecording: () => void;
  /** Capture a violation clip (~10s total) and upload */
  captureViolationClip: (violationId: string) => void;
}

export function useRollingBuffer({
  sessionId,
  bufferDuration = 5,
  chunkIntervalMs = 1000,
}: UseRollingBufferOptions): RollingBufferAPI {
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const maxChunks = Math.ceil((bufferDuration * 1000) / chunkIntervalMs);
  const capturingRef = useRef(false);
  const captureChunksRef = useRef<Blob[]>([]);
  const captureViolationIdRef = useRef<string>("");
  const captureTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const preCaptureChunksRef = useRef<Blob[]>([]);

  const uploadCapturedChunks = useCallback(async () => {
    const allChunks = [...preCaptureChunksRef.current, ...captureChunksRef.current];
    preCaptureChunksRef.current = [];
    captureChunksRef.current = [];

    if (allChunks.length === 0) {
      console.warn("[RollingBuffer] No chunks to capture");
      return;
    }

    const blob = new Blob(allChunks, { type: "video/webm" });
    console.log(`[RollingBuffer] Clip size: ${(blob.size / 1024).toFixed(1)}KB`);

    const arrayBuffer = await blob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < uint8.byteLength; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    const base64 = btoa(binary);

    await api.uploadViolationVideo(
      sessionId,
      captureViolationIdRef.current,
      base64
    );

    console.log("[RollingBuffer] Clip uploaded successfully");
  }, [sessionId]);

  const startRecording = useCallback(
    (stream: MediaStream) => {
      if (mediaRecorderRef.current) return;

      // Determine supported MIME type
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? "video/webm;codecs=vp8,opus"
        : "video/webm";

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 500_000, // 500kbps – low quality but visible
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;

        // Add to ring buffer
        chunksRef.current.push(event.data);
        if (chunksRef.current.length > maxChunks) {
          chunksRef.current.shift(); // Drop oldest chunk
        }

        // If we're in capture mode, also collect post-violation chunks
        if (capturingRef.current) {
          captureChunksRef.current.push(event.data);
        }
      };

      recorder.start(chunkIntervalMs); // Produce chunk every 2s
      mediaRecorderRef.current = recorder;
      setIsRecording(true);

      console.log("[RollingBuffer] Started recording");
    },
    [chunkIntervalMs, maxChunks]
  );

  const stopRecording = useCallback(() => {
    if (captureTimeoutRef.current) {
      clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = null;
    }

    if (capturingRef.current) {
      capturingRef.current = false;
      void uploadCapturedChunks().catch((err: any) => {
        console.error("[RollingBuffer] Finalize upload failed:", err.message);
      });
    }

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    chunksRef.current = [];
    preCaptureChunksRef.current = [];
    setIsRecording(false);
    console.log("[RollingBuffer] Stopped recording");
  }, [uploadCapturedChunks]);

  const captureViolationClip = useCallback(
    (violationId: string) => {
      // Don't capture if already capturing or not recording
      if (capturingRef.current || !mediaRecorderRef.current) return;

      console.log(`[RollingBuffer] Capturing violation clip: ${violationId}`);

      capturingRef.current = true;
      captureViolationIdRef.current = violationId;

      // Keep the current ring buffer as the pre-violation window.
      preCaptureChunksRef.current = [...chunksRef.current];
      captureChunksRef.current = [];

      // Collect an additional post-violation window of equal duration.
      captureTimeoutRef.current = setTimeout(async () => {
        capturingRef.current = false;
        captureTimeoutRef.current = null;

        try {
          await uploadCapturedChunks();
        } catch (err: any) {
          console.error("[RollingBuffer] Upload failed:", err.message);
        }
      }, bufferDuration * 1000);
    },
    [bufferDuration, uploadCapturedChunks]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, [stopRecording]);

  return {
    isRecording,
    startRecording,
    stopRecording,
    captureViolationClip,
  };
}
