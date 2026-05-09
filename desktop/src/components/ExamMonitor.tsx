import React, { useRef, useState, useCallback, useEffect } from "react";
import { useMicVAD } from "@ricky0123/vad-react";
import { useRollingBuffer } from "../hooks/useRollingBuffer";

interface ExamMonitorProps {
  webSocketUrl: string;
  sessionId: string;
  onVerdict?: (verdict: MonitorVerdict, captureViolationClip: (violationId: string) => void) => void;
}

export interface MonitorVerdict {
  status: string;
  message: string;
  level: number;
  details?: Record<string, unknown>;
}

const STATUS_LABELS: Record<string, string> = {
  NORMAL: "Bình thường",
  MILD_WARNING: "Cảnh báo nhẹ",
  WARNING_LEVEL_1: "Cảnh báo mức 1",
  WARNING_LEVEL_2_URGENT: "Cảnh báo mức 2",
};

const levelColors: Record<number, string> = {
  0: "#45d59a",
  1: "#ffbf5f",
  2: "#ff9b5c",
  3: "#ff5d7d",
};

const ExamMonitor: React.FC<ExamMonitorProps> = ({ webSocketUrl, sessionId, onVerdict }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const speechDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const isSpeakingRef = useRef(false);
  const captureIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const [isSpeaking, setIsSpeaking] = useState(false);
  const [verdict, setVerdict] = useState<MonitorVerdict | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  const { startRecording, captureViolationClip } = useRollingBuffer({
    sessionId,
    bufferDuration: 5,
    chunkIntervalMs: 1000,
  });

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
        onVerdict?.(data, captureViolationClip);
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
  }, [captureViolationClip, onVerdict, webSocketUrl]);

  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({
        video: { width: 854, height: 480, frameRate: 15 },
        audio: true,
      })
      .then((stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        startRecording(stream);
      })
      .catch(console.error);
  }, [startRecording]);

  const captureAndSend = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ws = wsRef.current;

    if (!video || !canvas || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    canvas.width = 640;
    canvas.height = 480;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const base64Image = canvas.toDataURL("image/jpeg", 0.7);
    ws.send(
      JSON.stringify({
        speech_detected: isSpeakingRef.current,
        timestamp: Date.now(),
        image: base64Image,
      })
    );
  }, []);

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

  useEffect(() => {
    const bgTimer = setInterval(() => {
      if (!isSpeakingRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
        captureAndSend();
      }
    }, 1000);

    return () => clearInterval(bgTimer);
  }, [captureAndSend]);

  useEffect(() => {
    return () => {
      stopCapture();
      if (speechDebounceRef.current) {
        clearTimeout(speechDebounceRef.current);
      }
    };
  }, [stopCapture]);

  const verdictColor = verdict ? levelColors[verdict.level] || "#6b7280" : "#6b7280";
  const speechDetected = Boolean(verdict?.details?.speech_detected);

  return (
    <div style={styles.shell}>
      <div style={styles.frame}>
        <video ref={videoRef} autoPlay playsInline muted style={styles.video} />
        <canvas ref={canvasRef} style={{ display: "none" }} />

        <div style={styles.topRow}>
          <div
            style={{
              ...styles.statusChip,
              background: wsConnected ? "rgba(69, 213, 154, 0.18)" : "rgba(109, 124, 146, 0.18)",
              color: wsConnected ? "#9cf0cc" : "#c8d3e3",
            }}
          >
            {wsConnected ? "Kết nối AI ổn định" : "Đang kết nối AI"}
          </div>

          <div
            style={{
              ...styles.statusChip,
              background: isSpeaking ? "rgba(255, 93, 125, 0.18)" : "rgba(69, 213, 154, 0.18)",
              color: isSpeaking ? "#ffb1c0" : "#9cf0cc",
            }}
          >
            {isSpeaking ? "Đang phát hiện giọng nói" : "Âm thanh yên tĩnh"}
          </div>
        </div>

        {vad.loading && <div style={styles.loadingHint}>Đang khởi tạo mô-đun nhận diện giọng nói...</div>}

        {vad.errored && (
          <div style={styles.errorHint}>
            Không thể khởi tạo microphone: {(vad.errored as any).message || String(vad.errored)}
          </div>
        )}

        {!vad.loading && !vad.errored && !vad.listening && (
          <button onClick={() => vad.start()} style={styles.micButton}>
            Bật lại microphone
          </button>
        )}

        {verdict && verdict.level > 0 && (
          <div style={{ ...styles.verdictPanel, borderLeftColor: verdictColor }}>
            <div style={{ ...styles.verdictHeader, color: verdictColor }}>
              {STATUS_LABELS[verdict.status] || verdict.status}
            </div>
            <div style={styles.verdictMessage}>{verdict.message}</div>
            <div style={styles.verdictMeta}>
              <span>Mức: {verdict.level}</span>
              <span>Số khuôn mặt: {String(verdict.details?.face_count ?? 0)}</span>
              <span>Âm thanh: {speechDetected ? "Có" : "Không"}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  frame: {
    position: "relative",
    borderRadius: 20,
    overflow: "hidden",
    border: "1px solid rgba(158, 192, 245, 0.16)",
    background: "rgba(4, 11, 19, 0.92)",
    boxShadow: "0 20px 44px rgba(0, 0, 0, 0.28)",
  },
  video: {
    display: "block",
    width: "100%",
    maxWidth: 640,
    aspectRatio: "4 / 3",
    objectFit: "cover",
    background: "#02070d",
  },
  topRow: {
    position: "absolute",
    top: 12,
    left: 12,
    right: 12,
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
  },
  statusChip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid rgba(255, 255, 255, 0.08)",
    backdropFilter: "blur(10px)",
    fontSize: 12,
    fontWeight: 700,
  },
  loadingHint: {
    position: "absolute",
    left: 12,
    bottom: 12,
    padding: "8px 12px",
    borderRadius: 12,
    background: "rgba(9, 18, 32, 0.78)",
    color: "#d8e7ff",
    fontSize: 12,
  },
  errorHint: {
    position: "absolute",
    left: 12,
    bottom: 12,
    right: 12,
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(255, 93, 125, 0.18)",
    border: "1px solid rgba(255, 93, 125, 0.26)",
    color: "#ffd1da",
    fontSize: 12,
    lineHeight: 1.5,
  },
  micButton: {
    position: "absolute",
    right: 12,
    bottom: 12,
    border: "none",
    borderRadius: 12,
    background: "linear-gradient(135deg, #57a6ff, #2dd4bf)",
    color: "#04111d",
    fontWeight: 700,
    padding: "10px 14px",
    cursor: "pointer",
  },
  verdictPanel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 12,
    padding: "12px 14px",
    borderRadius: 16,
    background: "rgba(4, 11, 19, 0.9)",
    borderLeft: "4px solid transparent",
    boxShadow: "0 10px 26px rgba(0, 0, 0, 0.3)",
  },
  verdictHeader: {
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 6,
  },
  verdictMessage: {
    fontSize: 13,
    color: "#f2f7ff",
    lineHeight: 1.5,
    marginBottom: 6,
  },
  verdictMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    fontSize: 11,
    color: "#9fb0c7",
  },
};

export default ExamMonitor;
