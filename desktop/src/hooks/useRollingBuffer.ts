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
  /** Buffer duration in seconds (default 10) */
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
  /** Capture a violation clip (~10s) and upload */
  captureViolationClip: (violationId: string) => void;
}

export function useRollingBuffer({
  sessionId,
  bufferDuration = 10,
  chunkIntervalMs = 2000,
}: UseRollingBufferOptions): RollingBufferAPI {
  const [isRecording, setIsRecording] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const maxChunks = Math.ceil((bufferDuration * 1000) / chunkIntervalMs);
  const capturingRef = useRef(false);
  const captureChunksRef = useRef<Blob[]>([]);
  const captureViolationIdRef = useRef<string>("");
  const captureTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    chunksRef.current = [];
    capturingRef.current = false;
    captureChunksRef.current = [];
    if (captureTimeoutRef.current) {
      clearTimeout(captureTimeoutRef.current);
      captureTimeoutRef.current = null;
    }
    setIsRecording(false);
    console.log("[RollingBuffer] Stopped recording");
  }, []);

  const captureViolationClip = useCallback(
    (violationId: string) => {
      // Don't capture if already capturing or not recording
      if (capturingRef.current || !mediaRecorderRef.current) return;

      console.log(`[RollingBuffer] Capturing violation clip: ${violationId}`);

      capturingRef.current = true;
      captureViolationIdRef.current = violationId;

      // Take the current buffer content (= ~5s of pre-violation footage)
      const preChunks = [...chunksRef.current];
      captureChunksRef.current = [];

      // Wait 5s to collect post-violation footage
      captureTimeoutRef.current = setTimeout(async () => {
        capturingRef.current = false;

        // Merge pre + post chunks into single blob
        const allChunks = [...preChunks, ...captureChunksRef.current];
        captureChunksRef.current = [];

        if (allChunks.length === 0) {
          console.warn("[RollingBuffer] No chunks to capture");
          return;
        }

        const blob = new Blob(allChunks, { type: "video/webm" });
        console.log(`[RollingBuffer] Clip size: ${(blob.size / 1024).toFixed(1)}KB`);

        // Convert to base64 and send via IPC
        try {
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
        } catch (err: any) {
          console.error("[RollingBuffer] Upload failed:", err.message);
        }
      }, 5000);
    },
    [sessionId]
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
