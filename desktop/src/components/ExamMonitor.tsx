/**
 * src/components/ExamMonitor.tsx
 * ──────────────────────────────
 * Multimodal Exam Monitor – Gửi frame camera + cờ VAD qua WebSocket.
 * Integrated with Rolling Video Buffer for violation clip capture.
 *
 * Dependencies:
 *   npm install @ricky0123/vad-react @ricky0123/vad-web
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { useRollingBuffer } from "../hooks/useRollingBuffer";


interface ExamMonitorProps {
  /** WebSocket URL, vd: 'ws://localhost:8001/ws/monitor/session-123' */
  webSocketUrl: string;
  /** Session ID for video upload */
  sessionId: string;
  /** Callback khi có kết quả từ backend */
  onVerdict?: (verdict: MonitorVerdict, violationId?: string) => void;
}

/** Verdict từ backend */
export interface MonitorVerdict {
  status: string;
  message: string;
  level: number;
  details?: Record<string, unknown>;
}

const ExamMonitor: React.FC<ExamMonitorProps> = ({ webSocketUrl, sessionId, onVerdict }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // ── VAD debounce state ──
  const speechDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef = useRef(false);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [verdict, setVerdict] = useState<MonitorVerdict | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // Throttle: chỉ gửi frame mỗi 500ms (2 FPS) khi đang có speech
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // ── Rolling Buffer for violation clips ──────────────────────────────
  const { startRecording, captureViolationClip } = useRollingBuffer({
    sessionId,
    bufferDuration: 5,
    chunkIntervalMs: 1000,
  });

  // ── WebSocket connection ─────────────────────────────────────────────────
  useEffect(() => {
    const socket = new WebSocket(webSocketUrl);

    socket.onopen = () => {
      console.log("[ExamMonitor] WebSocket connected");
      setWsConnected(true);
    };

    socket.onmessage = (event) => {
      try {
        const data: MonitorVerdict = JSON.parse(event.data);
        setVerdict(data);
        const violationId = data.level >= 3 ? crypto.randomUUID() : undefined;
        onVerdict?.(data, violationId);

        // Capture violation clip for level >= 3
        if (violationId) {
          captureViolationClip(violationId);
        }
      } catch {
        console.warn("[ExamMonitor] Invalid verdict JSON");
      }
    };

    socket.onclose = () => {
      console.log("[ExamMonitor] WebSocket disconnected");
      setWsConnected(false);
    };

    socket.onerror = (err) => {
      console.error("[ExamMonitor] WebSocket error:", err);
    };

    wsRef.current = socket;

    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [webSocketUrl]);

  // ── Camera init ──────────────────────────────────────────────────────────
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({
        video: { width: 854, height: 480, frameRate: 15 },
        audio: true, // Include audio for rolling buffer
      })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        // Start rolling buffer recording with the combined stream
        startRecording(stream);
      })
      .catch(console.error);
  }, []);

  // ── Capture frame + send via WebSocket ───────────────────────────────────
  const captureAndSend = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ws = wsRef.current;

    if (!video || !canvas || !ws || ws.readyState !== WebSocket.OPEN) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    canvas.width = 640;
    canvas.height = 480;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // JPEG 70% quality – giảm ~33% kích thước so với PNG
    const base64Image = canvas.toDataURL("image/jpeg", 0.7);

    ws.send(
      JSON.stringify({
        speech_detected: isSpeakingRef.current,
        timestamp: Date.now(),
        image: base64Image,
      })
    );
  }, []);

  // ── Bắt đầu / dừng throttled capture ────────────────────────────────────
  const startCapture = useCallback(() => {
    captureAndSend();
    captureIntervalRef.current = setInterval(captureAndSend, 500);
  }, [captureAndSend]);

  const stopCapture = useCallback(() => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
  }, []);

  // ── VAD integration ───────────────────────────────────────────────────
  const vad = useMicVAD({
    startOnLoad: true,

    onnxWASMBasePath: "/",
    baseAssetPath: "/",
    model: "legacy",

    ortConfig: (ort: any) => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.wasmPaths = {
        "ort-wasm-simd-threaded.wasm": "/ort-wasm-simd-threaded.wasm",
        "ort-wasm-simd.wasm": "/ort-wasm-simd-threaded.wasm",
        "ort-wasm.wasm": "/ort-wasm-simd-threaded.wasm",
        "ort-wasm-threaded.wasm": "/ort-wasm-simd-threaded.wasm",
      };
    },

    onSpeechStart: () => {
      console.log("[VAD] Speech started");
      isSpeakingRef.current = true;
      setIsSpeaking(true);
      startCapture();
    },

    onSpeechEnd: () => {
      if (isSpeakingRef.current) {
        console.log("[VAD] Speech ended");
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        stopCapture();
        captureAndSend();
      }
    },

    onVADMisfire: () => {
      if (isSpeakingRef.current) {
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        stopCapture();
        captureAndSend();
      }
    },
  });

  // Background monitoring: gửi frame mỗi 1 giây ngay cả khi im lặng
  useEffect(() => {
    const bgTimer = setInterval(() => {
      if (!isSpeakingRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        captureAndSend();
      }
    }, 1000);

    return () => clearInterval(bgTimer);
  }, [captureAndSend]);

  // ── Cleanup on unmount ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopCapture();
      if (speechDebounceRef.current) {
        clearTimeout(speechDebounceRef.current);
      }
    };
  }, [stopCapture]);

  // ── UI ───────────────────────────────────────────────────────────────────
  const levelColors: Record<number, string> = {
    0: "#22c55e", // green – normal
    1: "#eab308", // yellow – mild
    2: "#f97316", // orange – level 1
    3: "#ef4444", // red – level 2 urgent
  };

  const verdictColor = verdict
    ? levelColors[verdict.level] || "#6b7280"
    : "#6b7280";

  return (
    <div style={{ position: "relative", maxWidth: 640 }}>
      {/* Camera preview */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{ width: "100%", maxWidth: "640px", borderRadius: 8 }}
      />

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      {/* VAD Status Badge */}
      <div
        style={{
          position: "absolute",
          top: 10,
          right: 10,
          display: "flex",
          flexDirection: "column",
          gap: 4,
          alignItems: "flex-end"
        }}
      >
        <div
          style={{
            padding: "6px 14px",
            background: isSpeaking ? "#ef4444" : "#22c55e",
            color: "white",
            borderRadius: 6,
            fontWeight: "bold",
            fontSize: 12,
            opacity: 0.9,
          }}
        >
          🎙 {isSpeaking ? "SPEAKING" : "Silent"}
        </div>

        {vad.loading && (
          <div style={{ fontSize: 10, color: "white", background: "rgba(0,0,0,0.5)", padding: "2px 6px", borderRadius: 4 }}>
            ⏳ VAD Loading...
          </div>
        )}
        {vad.errored && (
          <div style={{ fontSize: 10, color: "white", background: "rgba(255,0,0,0.8)", padding: "4px 8px", borderRadius: 4, maxWidth: 200, wordWrap: "break-word" }}>
            ❌ VAD Error: {(vad.errored as any).message || String(vad.errored)}
          </div>
        )}
        {!vad.loading && !vad.errored && !vad.listening && (
          <button
            onClick={() => vad.start()}
            style={{ fontSize: 10, padding: "2px 8px", cursor: "pointer", background: "#3b82f6", color: "white", border: "none", borderRadius: 4 }}
          >
            ▶ Start Mic
          </button>
        )}
      </div>

      {/* WebSocket Status */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: 10,
          padding: "4px 10px",
          background: wsConnected ? "rgba(34,197,94,0.8)" : "rgba(107,114,128,0.8)",
          color: "white",
          borderRadius: 4,
          fontSize: 10,
        }}
      >
        WS: {wsConnected ? "Connected" : "Disconnected"}
      </div>

      {/* Verdict Panel */}
      {verdict && verdict.level > 0 && (
        <div
          style={{
            position: "absolute",
            bottom: 10,
            left: 10,
            right: 10,
            padding: "10px 14px",
            background: "rgba(0,0,0,0.85)",
            borderLeft: `4px solid ${verdictColor}`,
            borderRadius: 6,
            color: "white",
            fontSize: 13,
          }}
        >
          <div style={{ fontWeight: "bold", color: verdictColor, marginBottom: 4 }}>
            ⚠ Lv.{verdict.level} – {verdict.status}
          </div>
          <div>{verdict.message}</div>
          {verdict.details && (
            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
              MAR: {(verdict.details.mar_value as number)?.toFixed(4)} |
              Δ: {(verdict.details.mar_delta as number)?.toFixed(4)} |
              Mouth: {String(verdict.details.is_mouth_moving)} |
              Away: {String(verdict.details.is_looking_away)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ExamMonitor;
