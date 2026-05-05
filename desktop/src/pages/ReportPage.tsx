/**
 * src/pages/ReportPage.tsx
 * ─────────────────────────
 * Post-exam report page showing violation summary and timeline.
 */

import React, { useEffect, useState } from "react";

const api = (window as any).electronAPI;

interface ViolationItem {
  id: string;
  event_type: string;
  severity: string;
  metadata: Record<string, any>;
  occurred_at: string;
}

interface ReportData {
  session_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  total_violations: number;
  violations_by_severity: Record<string, number>;
  violations_by_type: Array<{ event_type: string; count: number; severity: string }>;
  timeline: ViolationItem[];
}

const EVENT_LABELS: Record<string, string> = {
  tab_switch:        "Chuyển ứng dụng",
  fullscreen_exit:   "Thoát toàn màn hình",
  url_blocked:       "Truy cập URL bị chặn",
  popup_attempt:     "Cố mở tab/popup",
  no_face:           "Không thấy khuôn mặt",
  multiple_faces:    "Nhiều khuôn mặt",
  identity_mismatch: "Không khớp danh tính",
  speech_detected:   "Phát hiện giọng nói",
  voice_overlap:     "Chồng giọng",
  rapid_voice_change:"Thay đổi giọng đột ngột",
};

interface Props {
  sessionId: string;
  onNewExam: () => void;
}

export default function ReportPage({ sessionId, onNewExam }: Props) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchReport = async (retries = 3, delayMs = 2000) => {
    setLoading(true);
    setError("");
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data: ReportData = await api.getReport(sessionId);
        setReport(data);
        setLoading(false);
        return;
      } catch (e: any) {
        console.warn(`[ReportPage] Fetch attempt ${attempt}/${retries} failed:`, e.message);
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          setError("Không thể tải báo cáo: " + e.message);
        }
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchReport();
  }, [sessionId]);

  if (loading) {
    return (
      <div style={styles.center}>
        <div style={styles.spinner} />
        <p style={{ color: "var(--color-text-muted)" }}>Đang tải báo cáo...</p>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div style={styles.center}>
        <p style={{ color: "var(--color-danger)" }}>{error || "Lỗi không xác định"}</p>
        <div style={{ display: "flex", gap: 12 }}>
          <button className="btn btn-primary" onClick={() => fetchReport()}>🔄 Thử lại</button>
          <button className="btn btn-ghost" onClick={onNewExam}>← Về trang chủ</button>
        </div>
      </div>
    );
  }

  const duration = report.ended_at && report.started_at
    ? Math.round((new Date(report.ended_at).getTime() - new Date(report.started_at).getTime()) / 1000)
    : null;

  const severityOrder = ["critical", "high", "medium", "low"];

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <h1 style={styles.title}>📋 Báo cáo bài thi</h1>
            <p style={{ color: "var(--color-text-muted)", fontSize: 13 }}>
              Session: <code style={{ fontFamily: "var(--font-mono)" }}>{sessionId.slice(0, 8)}…</code>
            </p>
          </div>
          <button className="btn btn-ghost" onClick={onNewExam}>
            + Thi mới
          </button>
        </div>

        {/* Summary cards */}
        <div style={styles.statsGrid}>
          <StatCard
            label="Tổng vi phạm"
            value={report.total_violations}
            color={report.total_violations === 0 ? "var(--color-success)" : "var(--color-warning)"}
          />
          <StatCard
            label="Nghiêm trọng"
            value={report.violations_by_severity?.critical || 0}
            color="var(--color-critical)"
          />
          <StatCard
            label="Cao"
            value={report.violations_by_severity?.high || 0}
            color="var(--color-danger)"
          />
          <StatCard
            label="Thời gian thi"
            value={duration ? `${Math.floor(duration / 60)}m ${duration % 60}s` : "—"}
            color="var(--color-primary)"
          />
        </div>

        {/* By type */}
        {report.violations_by_type.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={styles.sectionTitle}>Vi phạm theo loại</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {report.violations_by_type.map(t => (
                <div key={t.event_type} style={styles.typeRow}>
                  <span className={`badge badge-${t.severity}`}>{t.severity}</span>
                  <span style={{ flex: 1, fontSize: 13 }}>
                    {EVENT_LABELS[t.event_type] || t.event_type}
                  </span>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-text-muted)" }}>
                    ×{t.count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="card">
          <h2 style={styles.sectionTitle}>Timeline vi phạm</h2>
          {report.timeline.length === 0 ? (
            <p style={{ color: "var(--color-success)", fontSize: 13 }}>
              ✓ Không có vi phạm nào được ghi nhận
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
              {report.timeline.map(v => (
                <div key={v.id} style={styles.timelineItem}>
                  <span style={styles.timelineTime}>
                    {new Date(v.occurred_at).toLocaleTimeString("vi-VN")}
                  </span>
                  <span className={`badge badge-${v.severity}`}>{v.severity}</span>
                  <span style={{ fontSize: 12, color: "var(--color-text)" }}>
                    {EVENT_LABELS[v.event_type] || v.event_type}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: {
  label: string; value: number | string; color: string;
}) {
  return (
    <div className="card" style={{ textAlign: "center" }}>
      <div style={{ fontSize: 28, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>{label}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--color-bg)",
    padding: "32px 16px",
    overflowY: "auto",
  },
  container: {
    maxWidth: 720,
    margin: "0 auto",
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100vh",
    gap: 16,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 24,
  },
  title: {
    fontSize: 24,
    fontWeight: 700,
    margin: 0,
    color: "var(--color-text)",
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: "var(--color-text-muted)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    margin: "0 0 12px",
  },
  typeRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    background: "var(--color-surface-2)",
    borderRadius: 6,
  },
  timelineItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 8px",
    background: "var(--color-surface-2)",
    borderRadius: 6,
    border: "1px solid var(--color-border)",
  },
  timelineTime: {
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    color: "var(--color-text-dim)",
    minWidth: 72,
  },
  spinner: {
    width: 36,
    height: 36,
    borderRadius: "50%",
    border: "3px solid var(--color-border)",
    borderTopColor: "var(--color-primary)",
    animation: "spin 0.8s linear infinite",
  },
};
