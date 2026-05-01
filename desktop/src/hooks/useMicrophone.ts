/**
 * src/hooks/useMicrophone.ts
 * ───────────────────────────
 * Custom hook that manages microphone capture and audio analysis.
 * Records audio in 3-second windows and sends base64 PCM to AI service.
 *
 * Uses Web Audio API + ScriptProcessorNode for real-time PCM extraction.
 * The PCM is captured at 16kHz mono to match VAD requirements.
 */

import { useRef, useState, useCallback, useEffect } from "react";

const api = (window as any).electronAPI;

export interface MicStatus {
  isRunning: boolean;
  hasSpeech: boolean;
  voiceOverlap: boolean;
  rapidChange: boolean;
  lastViolation: string | null;
  lastError: string | null;
}

interface Options {
  sessionId: string;
  userId: string;
  windowSeconds?: number;
  onViolation?: (type: string, severity: string, metadata: Record<string, unknown>) => void;
}

const TARGET_SAMPLE_RATE = 16000;

export function useMicrophone({
  sessionId,
  userId,
  windowSeconds = 3,
  onViolation,
}: Options) {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const pcmBufferRef = useRef<Int16Array[]>([]);
  const samplesPerWindow = TARGET_SAMPLE_RATE * windowSeconds;

  const [status, setStatus] = useState<MicStatus>({
    isRunning: false,
    hasSpeech: false,
    voiceOverlap: false,
    rapidChange: false,
    lastViolation: null,
    lastError: null,
  });

  // ── Send audio window for analysis ──────────────────────────────
  const analyzeWindow = useCallback(
    async (pcmBuffer: Int16Array[]) => {
      // Concatenate chunks into single buffer
      const totalLen = pcmBuffer.reduce((s, c) => s + c.length, 0);
      const merged = new Int16Array(totalLen);
      let offset = 0;
      for (const chunk of pcmBuffer) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      // Encode as base64 safely (avoid spread operator for large buffers)
      const uint8 = new Uint8Array(merged.buffer);
      let binary = "";
      for (let i = 0; i < uint8.byteLength; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      const b64 = btoa(binary);
      try {
        const result = await api.analyzeAudio(b64, sessionId);

        setStatus(s => ({
          ...s,
          hasSpeech: result.has_speech,
          voiceOverlap: result.voice_overlap_detected,
          rapidChange: result.rapid_changes_detected,
          lastViolation: result.suggested_violation || null,
        }));

        // ── Violation dispatch ─────────────────────────────────────
        if (result.suggested_violation) {
          onViolation?.(
            result.suggested_violation,
            result.suggested_severity,
            {
              speech_ratio: result.speech_ratio,
              overlap_score: result.overlap_score,
              rapid_change_count: result.rapid_change_count,
            }
          );
        }
      } catch (e: any) {
        console.warn("[useMicrophone] Analysis error:", e.message);
      }
    },
    [sessionId, onViolation]
  );

  // ── Start recording ─────────────────────────────────────────────
  const startMic = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Create AudioContext at target sample rate
      const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
      audioCtxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      // 4096 samples ≈ 256ms buffer
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      let samplesAccumulated = 0;

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0);
        // Convert float32 → int16
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        }
        pcmBufferRef.current.push(int16);
        samplesAccumulated += int16.length;

        // When we have a full window, analyze and reset
        if (samplesAccumulated >= samplesPerWindow) {
          const windowBuffer = [...pcmBufferRef.current];
          pcmBufferRef.current = [];
          samplesAccumulated = 0;
          analyzeWindow(windowBuffer);
        }
      };

      source.connect(processor);
      processor.connect(ctx.destination);

      setStatus(s => ({ ...s, isRunning: true, lastError: null }));
    } catch (e: any) {
      const msg = "Microphone không khả dụng: " + (e.message || "quyền bị từ chối");
      setStatus(s => ({ ...s, lastError: msg }));
      onViolation?.("mic_unavailable", "high", { error: e.message });
    }
  }, [analyzeWindow, samplesPerWindow, onViolation]);

  // ── Stop recording ──────────────────────────────────────────────
  const stopMic = useCallback(() => {
    processorRef.current?.disconnect();
    audioCtxRef.current?.close();
    processorRef.current = null;
    audioCtxRef.current = null;
    pcmBufferRef.current = [];
    setStatus(s => ({ ...s, isRunning: false }));
  }, []);

  // Cleanup on unmount
  useEffect(() => () => stopMic(), [stopMic]);

  return { status, startMic, stopMic };
}
