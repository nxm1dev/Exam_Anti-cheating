import React, { useState, useCallback } from "react";
import ExamMonitor, { MonitorVerdict } from "../components/ExamMonitor";

interface LogEntry {
  id: string;
  time: Date;
  verdict: MonitorVerdict;
}

export default function TestPage({ onBack }: { onBack: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const sessionId = "test-session-123";
  const wsUrl = `ws://127.0.0.1:8001/ws/monitor/${sessionId}`;

  const handleVerdict = useCallback((verdict: MonitorVerdict) => {
    // Chỉ log những kết quả có thay đổi trạng thái, có cảnh báo, hoặc thay đổi trạng thái nhận diện âm thanh
    setLogs((prev) => {
      const last = prev[0];
      const speechChanged = last && (last.verdict.details?.speech_detected !== verdict.details?.speech_detected);
      
      if (last && last.verdict.level === verdict.level && last.verdict.status === verdict.status && verdict.level === 0 && !speechChanged) {
        return prev; // Bỏ qua log spam nếu liên tục bình thường và âm thanh không đổi
      }
      return [{ id: crypto.randomUUID(), time: new Date(), verdict }, ...prev].slice(0, 50);
    });
  }, []);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={{ margin: 0, fontSize: 20 }}>🛠 Test Multimodal AI Monitor</h1>
        <button className="btn btn-ghost" onClick={onBack}>← Quay lại</button>
      </div>

      <div style={styles.content}>
        {/* Left: Camera & Monitor */}
        <div style={styles.cameraSection}>
          <div style={styles.card}>
            <p style={{ marginTop: 0, color: "var(--color-text-muted)" }}>
              Hãy thử các kịch bản sau:
              <br/> 1. Im lặng và rời khỏi camera (Không thấy mặt).
              <br/> 2. Nhìn thẳng và đọc nhẩm liên tục (Mức 1).
              <br/> 3. Quay đi chỗ khác và nói chuyện (Mức 2).
              <br/> 4. Bật âm thanh có tiếng người nói nhưng mím chặt môi (Mức 3 - Nhắc bài).
            </p>
            <ExamMonitor webSocketUrl={wsUrl} sessionId={sessionId} onVerdict={handleVerdict} />
          </div>
        </div>

        {/* Right: Live Logs */}
        <div style={styles.logSection}>
          <h3 style={{ margin: "0 0 12px 0" }}>Logs phản hồi từ AI Service</h3>
          <div style={styles.logContainer}>
            {logs.map((log) => (
              <div key={log.id} style={{
                ...styles.logItem,
                borderLeft: `4px solid ${getColor(log.verdict.level)}`
              }}>
                <div style={styles.logTime}>{log.time.toLocaleTimeString()}</div>
                <div style={{ fontWeight: 600, color: getColor(log.verdict.level) }}>
                  Lv.{log.verdict.level} - {log.verdict.status}
                </div>
                {!!log.verdict.details?.speech_detected && (
                  <div style={{ marginTop: 4, display: "inline-block", padding: "2px 8px", background: "#ef4444", color: "white", fontSize: 10, borderRadius: 4, fontWeight: "bold" }}>
                    🎙 PHÁT HIỆN ÂM THANH
                  </div>
                )}
                <div style={{ fontSize: 13, margin: "6px 0 4px 0" }}>{log.verdict.message}</div>
                {log.verdict.details && (
                  <pre style={styles.logDetails}>
                    {JSON.stringify(log.verdict.details, null, 2)}
                  </pre>
                )}
              </div>
            ))}
            {logs.length === 0 && (
              <div style={{ color: "var(--color-text-dim)", textAlign: "center", marginTop: 20 }}>
                Chưa có dữ liệu...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function getColor(level: number) {
  if (level === 0) return "#22c55e"; // green
  if (level === 1) return "#eab308"; // yellow
  if (level === 2) return "#f97316"; // orange
  if (level === 3) return "#ef4444"; // red
  return "#6b7280"; // gray
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: "100vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--color-bg)",
    color: "var(--color-text)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 24px",
    background: "var(--color-surface)",
    borderBottom: "1px solid var(--color-border)",
  },
  content: {
    display: "flex",
    flex: 1,
    overflow: "hidden",
  },
  cameraSection: {
    flex: 1,
    padding: 24,
    display: "flex",
    justifyContent: "center",
    alignItems: "flex-start",
    overflowY: "auto",
  },
  card: {
    background: "var(--color-surface)",
    padding: 20,
    borderRadius: 12,
    border: "1px solid var(--color-border)",
    width: "100%",
    maxWidth: 680,
  },
  logSection: {
    width: 400,
    background: "var(--color-surface-2)",
    borderLeft: "1px solid var(--color-border)",
    padding: 20,
    display: "flex",
    flexDirection: "column",
  },
  logContainer: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  logItem: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 6,
    padding: "10px 12px",
  },
  logTime: {
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    color: "var(--color-text-dim)",
    marginBottom: 4,
  },
  logDetails: {
    margin: "8px 0 0 0",
    padding: 8,
    background: "rgba(0,0,0,0.2)",
    borderRadius: 4,
    fontSize: 11,
    fontFamily: "var(--font-mono)",
    color: "#a1a1aa",
    overflowX: "auto",
  }
};
