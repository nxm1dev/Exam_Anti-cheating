/**
 * src/components/ExamMonitor.tsx
 * ──────────────────────────────
 * Multimodal Exam Monitor – Gửi frame camera + cờ VAD qua WebSocket.
 *
 * Nâng cấp so với bản cũ:
 *   1. Debounce 300ms cho VAD: onSpeechStart chỉ trigger sau 300ms
 *      để loại bỏ tiếng động quá ngắn (ho, hắng, tiếng gõ).
 *   2. Gửi cờ speech_detected đơn giản (boolean) thay vì cố moi
 *      probability từ @ricky0123/vad-react (library không hỗ trợ
 *      stream probability ra ngoài).
 *   3. Backend tự quản lý bộ đếm thời gian (speech_start_time)
 *      để thực hiện debounce 1.5s cho cảnh báo Level 2.
 *
 * Dependencies:
 *   npm install @ricky0123/vad-react @ricky0123/vad-web
 */

import React, { useRef, useState, useCallback, useEffect } from "react";
import { useMicVAD } from "@ricky0123/vad-react";


interface ExamMonitorProps {
  /** WebSocket URL, vd: 'ws://localhost:8001/ws/monitor/session-123' */
  webSocketUrl: string;
  /** Callback khi có kết quả từ backend */
  onVerdict?: (verdict: MonitorVerdict) => void;
}

/** Verdict từ backend */
export interface MonitorVerdict {
  status: string;
  message: string;
  level: number;
  details?: Record<string, unknown>;
}

export interface ExamMonitorHandle {
  getSnapshot: () => string | null;
  getEvidenceVideo: () => Promise<string | null>;
}

const ExamMonitor = React.forwardRef<ExamMonitorHandle, ExamMonitorProps>(({ webSocketUrl, onVerdict }, ref) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  
  // ── Video Buffer (15s) ──
  const mediaChunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Expose methods to parent
  React.useImperativeHandle(ref, () => ({
    getSnapshot: () => {
      if (canvasRef.current) {
        return canvasRef.current.toDataURL("image/jpeg", 0.7);
      }
      return null;
    },
    getEvidenceVideo: async () => {
      if (mediaChunksRef.current.length === 0) return null;
      
      const blob = new Blob(mediaChunksRef.current, { type: "video/webm" });
      
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          if (typeof reader.result === "string") {
            const b64 = reader.result.split(",")[1];
            resolve(b64);
          } else {
            reject(new Error("Failed to convert video to base64"));
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
  }));

  // ── VAD debounce state ──
  // Dùng useRef vì setTimeout callback cần giá trị mới nhất
  const speechDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef = useRef(false);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [verdict, setVerdict] = useState<MonitorVerdict | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  // Throttle: chỉ gửi frame mỗi 500ms (2 FPS) khi đang có speech
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);

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
        onVerdict?.(data);
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

  // ── Camera init & Video Recording ──────────────────────────────────────────
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ video: true, audio: false })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        // Setup MediaRecorder for 15s ring buffer
        try {
          const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });
          
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
              mediaChunksRef.current.push(event.data);
              // Keep only the last 15 seconds (assuming 1 chunk = 1 second)
              if (mediaChunksRef.current.length > 15) {
                mediaChunksRef.current.shift();
              }
            }
          };

          recorder.start(1000); // 1000ms = 1 second timeslice
          mediaRecorderRef.current = recorder;
        } catch (err) {
          console.error("[ExamMonitor] MediaRecorder setup failed:", err);
        }
      })
      .catch(console.error);

    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  // ── Capture frame + send via WebSocket ───────────────────────────────────
  // Scale xuống 640x480 + JPEG 70% để giảm payload (~30-50KB per frame)
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
    // Gửi frame đầu tiên ngay lập tức
    captureAndSend();
    // Sau đó throttle: 1 frame mỗi 500ms (2 FPS)
    captureIntervalRef.current = setInterval(captureAndSend, 500);
  }, [captureAndSend]);

  const stopCapture = useCallback(() => {
    if (captureIntervalRef.current) {
      clearInterval(captureIntervalRef.current);
      captureIntervalRef.current = null;
    }
  }, []);

  // ── VAD integration với DEBOUNCE 300ms ───────────────────────────────────
  // Vấn đề: onSpeechStart trigger ngay lập tức với BẤT KỲ âm thanh nào.
  //   - Tiếng ho: ~100ms → trigger rồi hết ngay
  //   - Tiếng gõ phím: ~50ms → cũng trigger
  //   → Gây false positive khi kết hợp với cross-check backend.
  //
  // Giải pháp: Delay 300ms trước khi chấp nhận onSpeechStart.
  //   - Nếu onSpeechEnd hoặc onVADMisfire xảy ra trong 300ms → hủy.
  //   - Chỉ khi âm thanh kéo dài > 300ms mới xác nhận là "speech".
  const vad = useMicVAD({
    startOnLoad: true,

    // ── WASM / ONNX file paths ──────────────────────────────────────────────
    onnxWASMBasePath: "/",
    baseAssetPath: "/",
    model: "legacy",

    // Cấu hình ONNX Runtime
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
        // Gửi 1 frame cuối với speech_detected=false
        captureAndSend();
      }
    },

    onVADMisfire: () => {
      // VAD misfire = false positive (âm thanh quá ngắn cho VAD)
      if (isSpeakingRef.current) {
        isSpeakingRef.current = false;
        setIsSpeaking(false);
        stopCapture();
        captureAndSend();
      }
    },
  });

  // Background monitoring: gửi frame mỗi 1 giây ngay cả khi im lặng
  // để đảm bảo vẫn phát hiện được lỗi "không thấy mặt" hoặc "nhiều mặt" liên tục.
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
              Var: {(verdict.details.mar_variance as number)?.toFixed(6)} |
              Moving: {String(verdict.details.is_mouth_moving)}
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ExamMonitor;
