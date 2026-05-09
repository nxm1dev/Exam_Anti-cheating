import React, { useMemo, useState } from "react";

export interface ExamConfig {
  userId: string;
  examUrl: string;
}

interface Props {
  onExamStart: (info: {
    sessionId: string;
    userId: string;
    referenceEmbeddingB64?: string;
  }) => void;
  onTestMode?: () => void;
}

const api = (window as any).electronAPI;

const EXAM_RULES = [
  "Luôn ngồi một mình trong khung hình và giữ khuôn mặt rõ nét.",
  "Không chuyển tab, không mở thêm phần mềm, không rời màn hình thi.",
  "Mọi cảnh báo mức 2 sẽ được lưu kèm mốc thời gian để giám sát lại.",
];

const EXAM_STEPS = [
  {
    title: "Xác thực thí sinh",
    description: "Nhập đúng họ tên và email để gắn với phiên thi.",
  },
  {
    title: "Mở đúng bài thi",
    description: "Chỉ các đường dẫn nằm trong danh sách cho phép mới được tải.",
  },
  {
    title: "Bắt đầu giám sát",
    description: "Camera, micro và chế độ khóa màn hình sẽ được kích hoạt trước khi làm bài.",
  },
];

export default function SetupPage({ onExamStart, onTestMode }: Props) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [examUrl, setExamUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const trimmedFullName = fullName.trim();
  const trimmedEmail = email.trim();
  const trimmedExamUrl = examUrl.trim();
  const isRegistered = Boolean(userId);

  const progressText = useMemo(() => {
    if (!trimmedFullName && !trimmedEmail && !trimmedExamUrl) {
      return "Chưa bắt đầu";
    }
    if (!isRegistered) {
      return "Đang khai báo thông tin";
    }
    if (!trimmedExamUrl) {
      return "Đã xác thực thí sinh";
    }
    return "Sẵn sàng vào thi";
  }, [trimmedEmail, trimmedExamUrl, trimmedFullName, isRegistered]);

  const handleRegisterUser = async () => {
    if (!trimmedFullName || !trimmedEmail) {
      setError("Vui lòng nhập đầy đủ họ tên và email.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const user = await api.createUser({
        email: trimmedEmail,
        full_name: trimmedFullName,
        role: "candidate",
      });
      setUserId(user.id);
    } catch (event: any) {
      setError(event.message || "Không thể xác thực thông tin thí sinh.");
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!trimmedExamUrl) {
      setError("Vui lòng nhập đường dẫn bài thi.");
      return;
    }

    if (!userId) {
      setError("Vui lòng xác thực thí sinh trước khi bắt đầu.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const session = await api.startExam({
        userId,
        examUrl: trimmedExamUrl,
        userName: trimmedFullName,
        userEmail: trimmedEmail,
      });
      const user = await api.getUser(userId);

      onExamStart({
        sessionId: session.id,
        userId,
        referenceEmbeddingB64: user.face_embedding || undefined,
      });
    } catch (event: any) {
      setError(`Không thể bắt đầu phiên thi: ${event.message || "Lỗi chưa xác định"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.backdropGlow} />

      <div style={styles.shell}>
        <section style={styles.heroPanel}>
          <div style={styles.heroBadge}>SecureExam dành cho thí sinh</div>
          <h1 style={styles.heroTitle}>Vào thi trong một giao diện rõ ràng, gọn và không còn khoảng trống thừa.</h1>
          <p style={styles.heroCopy}>
            Hệ thống sẽ kiểm tra thông tin thí sinh, mở đúng đường dẫn bài thi và kích hoạt giám sát trước
            khi bạn bắt đầu làm bài. Toàn bộ nội dung hiển thị đã được chuẩn hóa sang tiếng Việt.
          </p>

          <div style={styles.heroStats}>
            <div style={styles.heroStatCard}>
              <span style={styles.heroStatLabel}>Trạng thái hiện tại</span>
              <strong style={styles.heroStatValue}>{progressText}</strong>
            </div>
            <div style={styles.heroStatCard}>
              <span style={styles.heroStatLabel}>Điều kiện lưu cảnh báo</span>
              <strong style={styles.heroStatValue}>Chỉ lưu cảnh báo mức 2</strong>
            </div>
          </div>

          <div style={styles.ruleBlock}>
            <h2 style={styles.blockTitle}>Lưu ý trước khi vào thi</h2>
            <div style={styles.ruleList}>
              {EXAM_RULES.map((rule, index) => (
                <div key={rule} style={styles.ruleItem}>
                  <span style={styles.ruleIndex}>0{index + 1}</span>
                  <span>{rule}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={styles.timelineBlock}>
            {EXAM_STEPS.map((step, index) => (
              <div key={step.title} style={styles.timelineItem}>
                <div style={styles.timelineDot}>{index + 1}</div>
                <div>
                  <div style={styles.timelineTitle}>{step.title}</div>
                  <div style={styles.timelineCopy}>{step.description}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section style={styles.formPanel}>
          <div style={styles.formHeader}>
            <div>
              <div style={styles.formEyebrow}>Phiên thi mới</div>
              <h2 style={styles.formTitle}>Khai báo thông tin và mở bài thi</h2>
            </div>
            <div style={styles.statusChip}>
              {isRegistered ? "Đã xác thực" : "Chờ xác thực"}
            </div>
          </div>

          <div className="card" style={styles.card}>
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.cardStep}>Bước 1</div>
                <h3 style={styles.cardTitle}>Thông tin thí sinh</h3>
              </div>
              {isRegistered && <span style={styles.successPill}>Đã lưu</span>}
            </div>

            <div style={styles.fieldGrid}>
              <div style={styles.field}>
                <label style={styles.label}>Họ và tên</label>
                <input
                  className="input"
                  placeholder="Nguyễn Văn A"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  disabled={isRegistered}
                />
              </div>

              <div style={styles.field}>
                <label style={styles.label}>Email</label>
                <input
                  className="input"
                  placeholder="thisinh@truong.edu.vn"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={isRegistered}
                />
              </div>
            </div>

            <button
              className={isRegistered ? "btn btn-ghost" : "btn btn-primary"}
              onClick={handleRegisterUser}
              disabled={loading || isRegistered}
              style={styles.actionButton}
            >
              {isRegistered ? "Thông tin đã được xác thực" : "Xác thực thí sinh"}
            </button>
          </div>

          <div className="card" style={styles.card}>
            <div style={styles.cardHeader}>
              <div>
                <div style={styles.cardStep}>Bước 2</div>
                <h3 style={styles.cardTitle}>Đường dẫn bài thi</h3>
              </div>
            </div>

            <div style={styles.field}>
              <label style={styles.label}>URL được phép mở</label>
              <input
                className="input"
                placeholder="https://exam.example.edu/test/123"
                value={examUrl}
                onChange={(event) => setExamUrl(event.target.value)}
              />
            </div>

            <p style={styles.helperText}>
              Chỉ các URL nằm trong danh sách cho phép mới được hiển thị trong cửa sổ bài thi.
            </p>
          </div>

          {error && <div style={styles.error}>{error}</div>}

          <div style={styles.footerActions}>
            <button
              className="btn btn-primary"
              style={styles.primaryButton}
              onClick={handleStart}
              disabled={loading || !isRegistered}
            >
              {loading ? "Đang chuẩn bị phiên thi..." : "Bắt đầu vào thi"}
            </button>

            {onTestMode && (
              <button
                className="btn btn-ghost"
                style={styles.secondaryButton}
                onClick={onTestMode}
              >
                Mở chế độ kiểm thử AI Monitor
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    position: "relative",
    overflow: "hidden",
    background:
      "radial-gradient(circle at top left, rgba(31, 126, 255, 0.22), transparent 28%), radial-gradient(circle at bottom right, rgba(10, 209, 168, 0.18), transparent 26%), linear-gradient(180deg, #07111f 0%, #0a1729 52%, #08111e 100%)",
    padding: "32px 28px",
  },
  backdropGlow: {
    position: "absolute",
    inset: "auto 6% 10% auto",
    width: 260,
    height: 260,
    borderRadius: "50%",
    background: "rgba(33, 146, 255, 0.14)",
    filter: "blur(80px)",
    pointerEvents: "none",
  },
  shell: {
    position: "relative",
    zIndex: 1,
    maxWidth: 1380,
    margin: "0 auto",
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.1fr) minmax(420px, 0.9fr)",
    gap: 24,
    alignItems: "stretch",
  },
  heroPanel: {
    padding: "34px 34px 28px",
    borderRadius: 28,
    border: "1px solid rgba(156, 196, 255, 0.14)",
    background: "rgba(7, 16, 28, 0.82)",
    boxShadow: "0 28px 80px rgba(0, 0, 0, 0.28)",
    backdropFilter: "blur(18px)",
    display: "flex",
    flexDirection: "column",
    gap: 26,
    minHeight: "calc(100vh - 64px)",
    justifyContent: "space-between",
  },
  heroBadge: {
    display: "inline-flex",
    alignItems: "center",
    alignSelf: "flex-start",
    padding: "8px 14px",
    borderRadius: 999,
    background: "rgba(87, 166, 255, 0.12)",
    border: "1px solid rgba(87, 166, 255, 0.24)",
    color: "#9bd0ff",
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  heroTitle: {
    margin: 0,
    fontSize: "clamp(2.2rem, 4vw, 4.4rem)",
    lineHeight: 1.03,
    letterSpacing: "-0.05em",
    maxWidth: 760,
  },
  heroCopy: {
    margin: 0,
    maxWidth: 720,
    color: "var(--color-text-muted)",
    fontSize: 16,
    lineHeight: 1.7,
  },
  heroStats: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 16,
  },
  heroStatCard: {
    padding: "18px 20px",
    borderRadius: 20,
    background: "rgba(12, 25, 42, 0.86)",
    border: "1px solid rgba(156, 196, 255, 0.12)",
  },
  heroStatLabel: {
    display: "block",
    color: "var(--color-text-dim)",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 8,
  },
  heroStatValue: {
    fontSize: 22,
    lineHeight: 1.2,
  },
  ruleBlock: {
    display: "grid",
    gap: 14,
  },
  blockTitle: {
    margin: 0,
    fontSize: 16,
  },
  ruleList: {
    display: "grid",
    gap: 10,
  },
  ruleItem: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: 12,
    alignItems: "start",
    padding: "14px 16px",
    borderRadius: 18,
    background: "rgba(255, 255, 255, 0.035)",
    border: "1px solid rgba(255, 255, 255, 0.06)",
    color: "var(--color-text-muted)",
  },
  ruleIndex: {
    minWidth: 34,
    height: 34,
    borderRadius: 12,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(87, 166, 255, 0.12)",
    color: "#b9dcff",
    fontWeight: 700,
    fontSize: 12,
  },
  timelineBlock: {
    display: "grid",
    gap: 14,
  },
  timelineItem: {
    display: "grid",
    gridTemplateColumns: "auto 1fr",
    gap: 14,
    alignItems: "start",
  },
  timelineDot: {
    width: 38,
    height: 38,
    borderRadius: 999,
    background: "linear-gradient(135deg, rgba(87, 166, 255, 0.95), rgba(10, 209, 168, 0.76))",
    color: "#03111e",
    fontWeight: 800,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  timelineTitle: {
    fontSize: 15,
    fontWeight: 700,
    marginBottom: 4,
  },
  timelineCopy: {
    color: "var(--color-text-muted)",
    fontSize: 14,
    lineHeight: 1.6,
  },
  formPanel: {
    padding: 28,
    borderRadius: 28,
    border: "1px solid rgba(156, 196, 255, 0.14)",
    background: "rgba(9, 18, 32, 0.92)",
    boxShadow: "0 28px 80px rgba(0, 0, 0, 0.3)",
    backdropFilter: "blur(18px)",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  formHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  },
  formEyebrow: {
    color: "#8dc7ff",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    marginBottom: 8,
  },
  formTitle: {
    margin: 0,
    fontSize: 28,
    lineHeight: 1.12,
  },
  statusChip: {
    padding: "10px 14px",
    borderRadius: 999,
    background: "rgba(255, 255, 255, 0.05)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    color: "var(--color-text-muted)",
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  card: {
    padding: 20,
    background: "rgba(13, 27, 46, 0.78)",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 18,
  },
  cardStep: {
    color: "#89c5ff",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: 6,
  },
  cardTitle: {
    margin: 0,
    fontSize: 18,
  },
  successPill: {
    padding: "7px 12px",
    borderRadius: 999,
    background: "rgba(68, 212, 154, 0.14)",
    border: "1px solid rgba(68, 212, 154, 0.22)",
    color: "#7cf0c0",
    fontSize: 12,
    fontWeight: 700,
  },
  fieldGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 14,
  },
  field: {
    display: "grid",
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--color-text-muted)",
  },
  helperText: {
    margin: "12px 0 0",
    color: "var(--color-text-dim)",
    fontSize: 13,
    lineHeight: 1.6,
  },
  actionButton: {
    marginTop: 18,
    width: "100%",
    justifyContent: "center",
  },
  error: {
    background: "rgba(255, 107, 107, 0.12)",
    border: "1px solid rgba(255, 107, 107, 0.22)",
    borderRadius: 18,
    padding: "14px 16px",
    color: "#ffb4b4",
    fontSize: 13,
    lineHeight: 1.6,
  },
  footerActions: {
    display: "grid",
    gap: 12,
    marginTop: "auto",
  },
  primaryButton: {
    width: "100%",
    justifyContent: "center",
    padding: "15px 18px",
    fontSize: 15,
  },
  secondaryButton: {
    width: "100%",
    justifyContent: "center",
    borderStyle: "dashed",
  },
};
