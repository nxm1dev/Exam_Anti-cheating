/**
 * src/pages/ExamPage.tsx
 * ───────────────────────
 * The main exam monitoring page.
 * Layout: thin monitor toolbar at top (64px) + BrowserView below (managed by main process).
 *
 * Features:
 * - Pre-exam countdown (2:30) before lockdown
 * - 5-second focus warning when Alt+Tab detected
 * - 3-strike auto-cancel for repeated tab switching
 * - Camera + mic monitoring
 * - Real-time violation logging
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import ExamMonitor, { MonitorVerdict } from "../components/ExamMonitor";
import AlertBanner from "../components/AlertBanner";
import ViolationList from "../components/ViolationList";
import { useViolations } from "../hooks/useViolations";
import {
  LEVEL_TWO_LOG_COOLDOWN_MS,
  NO_FACE_LOG_THRESHOLD_MS,
} from "../lib/violationPolicy";

const api = (window as any).electronAPI;

interface Props {
  sessionId: string;
  userId: string;
  referenceEmbeddingB64?: string;
  onExamEnd: () => void;
}

type ExamPhase = "pre-exam" | "active";

const PRE_EXAM_DURATION = 150; // 2 minutes 30 seconds
const FOCUS_COUNTDOWN_DURATION = 5;
const MAX_TAB_SWITCHES = 3;

export default function ExamPage({
  sessionId,
  userId,
  onExamEnd,
}: Props) {
  // ── Phase management ─────────────────────────────────────────────
  const [examPhase, setExamPhase] = useState<ExamPhase>("pre-exam");
  const [preExamCountdown, setPreExamCountdown] = useState(PRE_EXAM_DURATION);

  // ── Exam state ───────────────────────────────────────────────────
  const [elapsed, setElapsed] = useState(0);
  const [showViolations, setShowViolations] = useState(false);
  const [latestAlert, setLatestAlert] = useState<{ id: number; msg: string; severity: string } | null>(null);
  const [monitorVerdict, setMonitorVerdict] = useState<MonitorVerdict | null>(null);
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);
  const noFaceStartedAtRef = useRef<number | null>(null);
  const levelTwoCooldownRef = useRef<Record<string, number>>({});

  // ── Focus warning (Alt+Tab / Window key) ─────────────────────────
  const [showFocusWarning, setShowFocusWarning] = useState(false);
  const [focusCountdown, setFocusCountdown] = useState(FOCUS_COUNTDOWN_DURATION);
  const [tabSwitchCount, setTabSwitchCount] = useState(0);
  const focusTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isCancelledRef = useRef(false);


  // ── Violations ─────────────────────────────────────────────────
  const { violations, addViolation, flushViolations } = useViolations({
    sessionId,
    userId,
  });

  const handleViolation = useCallback(
    (
      type: string,
      severity: string,
      metadata: Record<string, unknown>,
      customMsg?: string,
      violationId?: string
    ) => {
      addViolation(type, severity, metadata, customMsg, violationId);

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
        blocked_shortcut: "Phím tắt bị chặn!",
        blacklisted_process: "Phát hiện ứng dụng bị cấm!",
        multi_monitor_connected: "Phát hiện thêm màn hình!",
      };

      const msg = customMsg || messages[type] || `Vi phạm: ${type}`;

      setLatestAlert(prev => {
        if (prev && prev.msg === msg && (Date.now() - prev.id < 3000)) {
          return prev;
        }
        return { id: Date.now(), msg, severity };
      });
    },
    [addViolation]
  );

  const canEmitLevelTwoEvent = useCallback((eventType: string) => {
    const now = Date.now();
    const lastLoggedAt = levelTwoCooldownRef.current[eventType] || 0;
    if (now - lastLoggedAt < LEVEL_TWO_LOG_COOLDOWN_MS) {
      return false;
    }
    levelTwoCooldownRef.current[eventType] = now;
    return true;
  }, []);

  // ── Multimodal Monitoring Verdict ──────────────────────────────
  const handleMonitorVerdict = useCallback((
    verdict: MonitorVerdict,
    captureViolationClip: (violationId: string) => void
  ) => {
    setMonitorVerdict(verdict);

    const faceCount = Number(verdict.details?.face_count ?? 0);
    const details = verdict.details || {};

    if (faceCount === 0) {
      if (noFaceStartedAtRef.current === null) {
        noFaceStartedAtRef.current = Date.now();
      }

      const durationMs = Date.now() - noFaceStartedAtRef.current;
      if (durationMs >= NO_FACE_LOG_THRESHOLD_MS && canEmitLevelTwoEvent("no_face")) {
        const violationId = crypto.randomUUID();
        captureViolationClip(violationId);
        handleViolation(
          "no_face",
          "critical",
          {
            ...details,
            no_face_duration_ms: durationMs,
            no_face_duration_seconds: Math.floor(durationMs / 1000),
          },
          `Không phát hiện khuôn mặt trong khoảng ${Math.floor(durationMs / 1000)} giây.`,
          violationId
        );
      }
      return;
    }

    noFaceStartedAtRef.current = null;

    if (faceCount >= 2) {
      if (canEmitLevelTwoEvent("multiple_faces")) {
        const violationId = crypto.randomUUID();
        captureViolationClip(violationId);
        handleViolation(
          "multiple_faces",
          "critical",
          {
            ...details,
            confirmed_face_count: faceCount,
          },
          verdict.message,
          violationId
        );
      }
      return;
    }

    if (verdict.level === 3) {
      if (canEmitLevelTwoEvent("ai_cheating_l2")) {
        const violationId = crypto.randomUUID();
        captureViolationClip(violationId);
        handleViolation("ai_cheating_l2", "critical", details, verdict.message, violationId);
      }
      return;
    }

    if (verdict.level === 2) {
      handleViolation("ai_cheating_l1", "medium", details, verdict.message);
      return;
    }

    if (verdict.level === 1) {
      handleViolation("ai_cheating_mild", "low", details, verdict.message);
    }
  }, [canEmitLevelTwoEvent, handleViolation]);

  // ── Pre-exam Countdown ──────────────────────────────────────────
  useEffect(() => {
    if (examPhase !== "pre-exam") return;

    const timer = setInterval(() => {
      setPreExamCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          handleLockdown();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [examPhase]);

  // ── Lockdown state ──────────────────────────────────────────────
  const [isLocking, setIsLocking] = useState(false);
  const [lockdownError, setLockdownError] = useState<string | null>(null);

  const handleLockdown = async () => {
    if (isLocking) return;
    console.log("[ExamPage] handleLockdown triggered");
    setIsLocking(true);
    setLockdownError(null);

    try {
      // Timeout guard: if lockdown takes > 10s, something is wrong
      const lockdownPromise = api.lockdownExam();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Kích hoạt chế độ thi quá lâu (Timeout)")), 15000)
      );

      const result = await (Promise.race([lockdownPromise, timeoutPromise]) as Promise<any>);
      console.log("[ExamPage] Lockdown result:", result);

      if (result?.success === false || result?.error) {
        setLockdownError(result.error || "Không thể kích hoạt chế độ thi");
        setIsLocking(false);
        return;
      }

      console.log("[ExamPage] Transitioning to active phase");
      setExamPhase("active");
    } catch (err: any) {
      console.error("[ExamPage] Lockdown error:", err);
      setLockdownError(err.message || "Lỗi khi kích hoạt chế độ thi");
      setIsLocking(false);
    }
  };

  // ── Exam Timer ──────────────────────────────────────────────────
  useEffect(() => {
    if (examPhase !== "active") return;
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, [examPhase]);

  // ── Periodic violation flush ──────────────────────────────────
  useEffect(() => {
    flushTimerRef.current = setInterval(flushViolations, 5000);
    return () => {
      if (flushTimerRef.current) clearInterval(flushTimerRef.current);
    };
  }, [flushViolations]);

  // ── Focus Lost / Regained (Alt+Tab handling) ───────────────────
  useEffect(() => {
    if (examPhase !== "active") return;

    const unFocus = api.onFocusLost(() => {
      if (isCancelledRef.current) return;

      setShowFocusWarning(true);
      setFocusCountdown(FOCUS_COUNTDOWN_DURATION);

      // Start 5s countdown
      let remaining = FOCUS_COUNTDOWN_DURATION;
      if (focusTimerRef.current) clearInterval(focusTimerRef.current);

      focusTimerRef.current = setInterval(() => {
        remaining--;
        setFocusCountdown(remaining);

        if (remaining <= 0) {
          clearInterval(focusTimerRef.current!);
          focusTimerRef.current = null;
          // Time's up – auto-submit
          handleAutoSubmit("focus_timeout");
        }
      }, 1000);
    });

    const unFocusRegained = api.onFocusRegained(() => {
      if (isCancelledRef.current) return;

      // Cancel countdown
      if (focusTimerRef.current) {
        clearInterval(focusTimerRef.current);
        focusTimerRef.current = null;
      }
      setShowFocusWarning(false);

      // Increment tab switch count
      setTabSwitchCount(prev => {
        const newCount = prev + 1;
        handleViolation("app_focus_lost", "high", { tab_switch_count: newCount });

        if (newCount >= MAX_TAB_SWITCHES) {
          // 3 strikes – auto cancel
          handleCancelExam(`Vi phạm chuyển tab ${newCount} lần (tối đa ${MAX_TAB_SWITCHES})`);
        }

        return newCount;
      });
    });

    const unAutoSubmit = api.onExamAutoSubmit((reason: string) => {
      handleAutoSubmit(reason);
    });

    return () => {
      unFocus?.();
      unFocusRegained?.();
      unAutoSubmit?.();
      if (focusTimerRef.current) clearInterval(focusTimerRef.current);
    };
  }, [examPhase, handleViolation]);

  // ── Cheating alerts from main process ──────────────────────────
  useEffect(() => {
    const unCheating = api.onCheatingAlert((data: { type: string; detail: string }) => {
      handleViolation(data.type, "high", { detail: data.detail }, data.detail);
    });
    return () => unCheating?.();
  }, [handleViolation]);

  // ── End / Cancel exam ─────────────────────────────────────────
  const getViolationCounts = () => {
    const counts = { total_violations: violations.length, critical_count: 0, high_count: 0, medium_count: 0, low_count: 0 };
    for (const v of violations) {
      if (v.severity === "critical") counts.critical_count++;
      else if (v.severity === "high") counts.high_count++;
      else if (v.severity === "medium") counts.medium_count++;
      else if (v.severity === "low") counts.low_count++;
    }
    return counts;
  };

  const handleEndExam = async () => {
    await flushViolations();
    await api.endExam(sessionId, getViolationCounts());
    onExamEnd();
  };

  const handleAutoSubmit = async (reason: string) => {
    if (isCancelledRef.current) return;
    addViolation("exam_auto_submit", "critical", { reason }, reason);
    await flushViolations();
    await api.endExam(sessionId, getViolationCounts());
    onExamEnd();
  };

  const handleCancelExam = async (reason: string) => {
    if (isCancelledRef.current) return;
    isCancelledRef.current = true;

    addViolation("exam_cancelled", "critical", { reason, tab_switch_count: tabSwitchCount }, reason);
    await flushViolations();
    await api.cancelExam(sessionId, reason);
    onExamEnd();
  };

  const formatTime = (s: number) =>
    `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  const formatCountdown = (s: number) =>
    `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  const criticalCount = violations.filter(v => v.severity === "critical" || v.severity === "high").length;
  const wsUrl = `ws://127.0.0.1:8001/ws/monitor/${sessionId}`;

  // ── Pre-exam Banner (compact) ────────────────────────────────────
  const progressPercent = (preExamCountdown / PRE_EXAM_DURATION) * 100;
  const isUrgent = preExamCountdown <= 30;

  const preExamUI = examPhase === "pre-exam" && (
    <div style={styles.preExamBanner} className="fade-in">
      {/* Progress bar track */}
      <div style={styles.progressTrack}>
        <div
          style={{
            ...styles.progressFill,
            width: `${progressPercent}%`,
            background: isUrgent
              ? "linear-gradient(90deg, #ff4d6d, #f85149)"
              : "linear-gradient(90deg, #4f8ef7, #6ba0ff)",
          }}
          className="pre-exam-progress"
        />
      </div>

      {/* Banner content */}
      <div style={styles.bannerContent}>
        {/* Left: icon + label */}
        <div style={styles.bannerLeft}>
          <span style={styles.bannerIcon}>🛡️</span>
          <span style={styles.bannerLabel}>Chuẩn bị vào thi</span>
          <div style={styles.bannerDivider} />
          <div style={styles.warningIcons}>
            <span title="Camera & microphone sẽ được bật">📹</span>
            <span title="Phím tắt sẽ bị vô hiệu hóa">⌨️</span>
            <span title="Không được chuyển tab">🚫</span>
          </div>
        </div>

        {/* Center: countdown */}
        <div style={styles.bannerCenter}>
          <span
            style={{
              ...styles.bannerCountdown,
              color: isUrgent ? "var(--color-critical)" : "var(--color-primary)",
            }}
          >
            {formatCountdown(preExamCountdown)}
          </span>
        </div>

        {/* Right: start button + error */}
        <div style={styles.bannerRight}>
          {lockdownError && (
            <div style={{ 
              display: "flex", 
              alignItems: "center", 
              gap: 8, 
              background: "rgba(239,68,68,0.15)", 
              padding: "4px 12px", 
              borderRadius: 6,
              border: "1px solid rgba(239,68,68,0.3)",
              marginRight: 10
            }}>
              <span style={{ fontSize: 14 }}>⚠️</span>
              <span style={{ fontSize: 12, color: "#fca5a5", fontWeight: 500 }}>{lockdownError}</span>
            </div>
          )}
          <button
            className="btn btn-primary"
            style={{ padding: "8px 20px", fontSize: 13, fontWeight: 600, minWidth: 100 }}
            onClick={handleLockdown}
            disabled={isLocking}
          >
            {isLocking ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ ...styles.spinner, width: 14, height: 14, borderWidth: 2 }} />
                Đang chuẩn bị...
              </span>
            ) : (
              "🔒 Bắt đầu"
            )}
          </button>
        </div>
      </div>
    </div>
  );

  // ── Active Exam UI ──────────────────────────────────────────────
  return (
    <div style={{ ...styles.page, flexDirection: "column" }}>
      {preExamUI}
      {/* ── Focus Warning Overlay (5s countdown) ──────────────── */}
      {showFocusWarning && (
        <div style={styles.focusWarningOverlay}>
          <div style={styles.focusWarningCard}>
            <div style={styles.focusWarningIcon}>⚠️</div>
            <div style={styles.focusWarningCountdown}>{focusCountdown}</div>
            <h2 style={styles.focusWarningTitle}>QUAY LẠI BÀI THI!</h2>
            <p style={styles.focusWarningDesc}>
              Bạn đã rời khỏi cửa sổ thi. Quay lại trong {focusCountdown} giây
              hoặc bài thi sẽ được <strong>nộp tự động</strong>.
            </p>
            <div style={styles.focusWarningStrikes}>
              Vi phạm: {tabSwitchCount}/{MAX_TAB_SWITCHES}
              {tabSwitchCount >= MAX_TAB_SWITCHES - 1 && (
                <span style={{ color: "var(--color-critical)", marginLeft: 8 }}>
                  ⚠️ Lần tiếp theo bài thi sẽ bị HỦY!
                </span>
              )}
            </div>
          </div>
        </div>
      )}

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
          {tabSwitchCount > 0 && (
            <div style={styles.strikeCounter}>
              Tab: {tabSwitchCount}/{MAX_TAB_SWITCHES}
            </div>
          )}
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
          sessionId={sessionId}
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
  // ── Pre-exam Banner (compact) ────────────────────────────────────
  preExamBanner: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2000,
    background: "rgba(13,17,23,0.97)",
    backdropFilter: "blur(16px)",
    borderBottom: "1px solid var(--color-border)",
  },
  progressTrack: {
    position: "absolute" as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    background: "rgba(79,142,247,0.12)",
  },
  progressFill: {
    height: "100%",
    borderRadius: "0 2px 2px 0",
    transition: "width 1s linear",
  },
  bannerContent: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 20px",
    height: 52,
  },
  bannerLeft: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  bannerIcon: {
    fontSize: 20,
  },
  bannerLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text)",
    letterSpacing: "0.3px",
  },
  bannerDivider: {
    width: 1,
    height: 20,
    background: "var(--color-border)",
    margin: "0 4px",
  },
  warningIcons: {
    display: "flex",
    gap: 6,
    fontSize: 14,
    opacity: 0.6,
  },
  bannerCenter: {
    position: "absolute" as const,
    left: "50%",
    transform: "translateX(-50%)",
  },
  bannerCountdown: {
    fontFamily: "var(--font-mono)",
    fontSize: 22,
    fontWeight: 700,
    letterSpacing: "2px",
  },
  bannerRight: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexShrink: 0,
  },
  bannerError: {
    fontSize: 16,
    cursor: "help",
  },
  // ── Focus Warning Overlay ─────────────────────────────────────
  focusWarningOverlay: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 9999,
    background: "rgba(255, 0, 0, 0.15)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    animation: "fadeIn 0.2s ease",
  },
  focusWarningCard: {
    background: "rgba(13,17,23,0.97)",
    border: "2px solid var(--color-danger)",
    borderRadius: 16,
    padding: "40px",
    textAlign: "center" as const,
    maxWidth: 420,
    boxShadow: "0 0 60px rgba(248,81,73,0.4)",
  },
  focusWarningIcon: {
    fontSize: 48,
    marginBottom: 8,
  },
  focusWarningCountdown: {
    fontSize: 72,
    fontWeight: 800,
    fontFamily: "var(--font-mono)",
    color: "var(--color-danger)",
    lineHeight: 1,
    marginBottom: 8,
  },
  focusWarningTitle: {
    fontSize: 22,
    fontWeight: 700,
    color: "var(--color-danger)",
    margin: "0 0 8px",
  },
  focusWarningDesc: {
    fontSize: 14,
    color: "var(--color-text-muted)",
    marginBottom: 16,
    lineHeight: 1.5,
  },
  focusWarningStrikes: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-warning)",
    padding: "8px 14px",
    background: "rgba(240,167,50,0.1)",
    borderRadius: 8,
    border: "1px solid rgba(240,167,50,0.3)",
  },
  // ── Toolbar styles ─────────────────────────────────────────────
  toolbar: {
    position: "fixed" as const,
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
  strikeCounter: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--color-warning)",
    padding: "2px 8px",
    background: "rgba(240,167,50,0.1)",
    borderRadius: 4,
    border: "1px solid rgba(240,167,50,0.3)",
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
    position: "absolute" as const,
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
    position: "fixed" as const,
    top: 64,
    right: 0,
    width: 250,
    height: "calc(100vh - 64px)",
    background: "rgba(22,27,34,0.95)",
    borderLeft: "1px solid var(--color-border)",
    backdropFilter: "blur(8px)",
    padding: 12,
    display: "flex",
    flexDirection: "column" as const,
    gap: 12,
    overflowY: "auto" as const,
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
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginBottom: 8,
  },
  spinner: {
    width: 24,
    height: 24,
    border: "3px solid rgba(255, 255, 255, 0.1)",
    borderTop: "3px solid var(--color-primary)",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
};
