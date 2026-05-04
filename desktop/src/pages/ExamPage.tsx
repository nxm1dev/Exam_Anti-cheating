/**
 * src/pages/ExamPage.tsx
 * ───────────────────────
 * The main exam monitoring page.
 * Layout: thin monitor toolbar at top (64px) + BrowserView below (managed by main process).
 *
 * Responsibilities:
 * - Start camera + mic monitoring
 * - Display real-time status indicators
 * - Show violation alerts
 * - Emit violations to backend
 * - Provide "End Exam" control
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import ExamMonitor, { MonitorVerdict } from "../components/ExamMonitor";
import AlertBanner from "../components/AlertBanner";
import ViolationList from "../components/ViolationList";
import { useViolations } from "../hooks/useViolations";

const api = (window as any).electronAPI;

interface Props {
  sessionId: string;
  userId: string;
  referenceEmbeddingB64?: string;
  onExamEnd: () => void;
}

export default function ExamPage({
  sessionId,
  userId,
  onExamEnd,
}: Props) {
  const [elapsed, setElapsed] = useState(0);
  const [showViolations, setShowViolations] = useState(false);
  const [latestAlert, setLatestAlert] = useState<{ id: number; msg: string; severity: string } | null>(null);
  const [monitorVerdict, setMonitorVerdict] = useState<MonitorVerdict | null>(null);
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ── Violations ─────────────────────────────────────────────────
  const { violations, addViolation, flushViolations } = useViolations({
    sessionId,
    userId,
  });

  const handleViolation = useCallback(
    (type: string, severity: string, metadata: Record<string, unknown>, customMsg?: string) => {
      addViolation(type, severity, metadata);

      const messages: Record<string, string> = {
        multiple_faces: "Phát hiện nhiều khuôn mặt trong khung hình!",
        identity_mismatch: "Khuôn mặt không khớp với người đăng ký!",
        voice_overlap: "Phát hiện nhiều người nói cùng lúc!",
        no_face: "Không nhìn thấy khuôn mặt của bạn!",
        fullscreen_exit: "Bạn đã thoát khỏi chế độ toàn màn hình!",
        app_focus_lost: "Cảnh báo: Bạn đã mở phần mềm khác!",
        ai_cheating_mild: "Cảnh báo: Phát hiện đọc nhẩm / có âm thanh!",
        ai_cheating_l1: "Cảnh báo: Phát hiện nói chuyện bất thường!",
        ai_cheating_l2: "Cảnh báo: Phát hiện người khác nhắc bài!",
      };

      const msg = customMsg || messages[type] || `Vi phạm: ${type}`;

      setLatestAlert(prev => {
        // Nếu cùng 1 thông báo và cách nhau chưa tới 3 giây, giữ nguyên
        // Điều này giúp tránh chớp màn hình nếu AI liên tục gửi lỗi
        if (prev && prev.msg === msg && (Date.now() - prev.id < 3000)) {
          return prev;
        }
        return { id: Date.now(), msg, severity };
      });
    },
    [addViolation]
  );

  // ── Multimodal Monitoring Verdict ──────────────────────────────
  const handleMonitorVerdict = useCallback((verdict: MonitorVerdict) => {
    setMonitorVerdict(verdict);

    // Ánh xạ level từ backend sang violation logic của frontend
    if (verdict.level >= 1) {
      let severity = "low";
      let type = "ai_cheating_mild";

      if (verdict.level === 3) {
        severity = "high";
        type = "ai_cheating_l2";
      } else if (verdict.level === 2) {
        severity = "medium";
        type = "ai_cheating_l1";
      }

      // Nếu là lỗi cụ thể về mặt (không thấy mặt, nhiều mặt), log riêng
      const faceCount = verdict.details?.face_count as number;
      if (faceCount === 0) {
        handleViolation("no_face", "high", verdict.details || {}, verdict.message);
      } else if (faceCount > 1) {
        handleViolation("multiple_faces", "high", verdict.details || {}, verdict.message);
      } else {
        handleViolation(type, severity, verdict.details || {}, verdict.message);
      }
    }
  }, [handleViolation]);

  // ── Timer ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Periodic violation flush ──────────────────────────────────
  useEffect(() => {
    flushTimerRef.current = setInterval(flushViolations, 5000);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [flushViolations]);

  // ── Focus/fullscreen listeners from main process ───────────────
  useEffect(() => {
    const unFocus = api.onFocusLost(() => {
      handleViolation("app_focus_lost", "medium", {});
    });
    const unFull = api.onFullscreenChange((isFullscreen: boolean) => {
      if (!isFullscreen) {
        handleViolation("fullscreen_exit", "high", {});
      }
    });
    return () => { unFocus?.(); unFull?.(); };
  }, [handleViolation]);

  // ── End exam ───────────────────────────────────────────────────
  const handleEndExam = async () => {
    await flushViolations();
    await api.endExam(sessionId);
    onExamEnd();
  };

  const formatTime = (s: number) =>
    `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const criticalCount = violations.filter(v => v.severity === "critical" || v.severity === "high").length;

  const wsUrl = `ws://127.0.0.1:8001/ws/monitor/${sessionId}`;

  return (
    <div style={styles.page}>
      {/* ── Monitor toolbar (64px) ─────────────────────────────── */}
      <div style={styles.toolbar}>
        {/* Left: Status indicators */}
        <div style={styles.indicators}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: monitorVerdict ? (monitorVerdict.level > 1 ? "var(--color-critical)" : monitorVerdict.level === 1 ? "var(--color-warning)" : "var(--color-success)") : "var(--color-text-dim)"
              }}
              className="pulse"
            />
            <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>AI Monitor</span>
          </div>
          <div style={styles.timer}>{formatTime(elapsed)}</div>
        </div>

        {/* Center: Alert banner area */}
        <div style={styles.alertArea}>
          {latestAlert && (
            <AlertBanner
              updateKey={latestAlert.id}
              message={latestAlert.msg}
              severity={latestAlert.severity as any}
              onDismiss={() => setLatestAlert(null)}
            />
          )}
        </div>

        {/* Right: Violation count + End button */}
        <div style={styles.actions}>
          <button
            className="btn btn-ghost"
            onClick={() => setShowViolations(v => !v)}
            style={{ position: "relative" }}
          >
            🚨 Vi phạm
            {violations.length > 0 && (
              <span style={styles.badge}>{violations.length}</span>
            )}
          </button>
          <button className="btn btn-danger" onClick={handleEndExam}>
            ⏹ Nộp bài
          </button>
        </div>
      </div>

      {/* ── Side panel: camera + violations ───────────────────── */}
      <div style={styles.sidePanel}>
        <ExamMonitor
          webSocketUrl={wsUrl}
          onVerdict={handleMonitorVerdict}
        />

        {/* Violations panel */}
        {showViolations && (
          <div style={styles.violationPanel} className="fade-in">
            <div style={styles.violationHeader}>
              Vi phạm
              {criticalCount > 0 && (
                <span className="badge badge-critical" style={{ marginLeft: 6 }}>
                  {criticalCount} nghiêm trọng
                </span>
              )}
            </div>
            <ViolationList violations={violations} />
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    display: "flex",
    height: "100vh",
    background: "var(--color-bg)",
    position: "relative",
  },
  toolbar: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    height: 64,
    zIndex: 1000,
    background: "rgba(13,17,23,0.95)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid var(--color-border)",
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    gap: 16,
  },
  indicators: {
    display: "flex",
    alignItems: "center",
    gap: 16,
    flexShrink: 0,
  },
  timer: {
    fontFamily: "var(--font-mono)",
    fontSize: 13,
    color: "var(--color-text-muted)",
    paddingLeft: 8,
    borderLeft: "1px solid var(--color-border)",
  },
  alertArea: {
    flex: 1,
    display: "flex",
    justifyContent: "center",
    padding: "0 16px",
    maxWidth: 500,
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  badge: {
    position: "absolute",
    top: -4,
    right: -4,
    background: "var(--color-danger)",
    color: "#fff",
    borderRadius: "50%",
    width: 16,
    height: 16,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    fontWeight: 700,
  },
  sidePanel: {
    position: "fixed",
    top: 64,
    right: 0,
    width: 250,
    height: "calc(100vh - 64px)",
    background: "rgba(22,27,34,0.95)",
    borderLeft: "1px solid var(--color-border)",
    backdropFilter: "blur(8px)",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    overflowY: "auto",
    zIndex: 999,
  },
  violationPanel: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-border)",
    borderRadius: 8,
    padding: 12,
  },
  violationHeader: {
    display: "flex",
    alignItems: "center",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--color-text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginBottom: 8,
  },
};
