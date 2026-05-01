import React, { useState } from "react";

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

export default function SetupPage({ onExamStart, onTestMode }: Props) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [examUrl, setExamUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const handleRegisterUser = async () => {
    if (!fullName || !email) {
      setError("Vui long nhap day du ho ten va email.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const user = await api.createUser({
        email,
        full_name: fullName,
        role: "candidate",
      });
      setUserId(user.id);
    } catch (event: any) {
      setError(event.message || "Khong the dang ky nguoi dung.");
    } finally {
      setLoading(false);
    }
  };

  const handleStart = async () => {
    if (!examUrl) {
      setError("Vui long nhap URL bai thi.");
      return;
    }

    if (!userId) {
      setError("Vui long dang ky thong tin truoc.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      const session = await api.startExam({ userId, examUrl });
      const user = await api.getUser(userId);

      onExamStart({
        sessionId: session.id,
        userId,
        referenceEmbeddingB64: user.face_embedding || undefined,
      });
    } catch (event: any) {
      setError(`Khong the bat dau phien thi: ${event.message || "Loi khong xac dinh"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fade-in" style={styles.page}>
      <div style={styles.container}>
        <div style={styles.header}>
          <div style={styles.logo}>SEC</div>
          <h1 style={styles.title}>SecureExam</h1>
          <p style={styles.subtitle}>He thong thi truc tuyen an toan</p>
        </div>

        <div className="card fade-in" style={{ marginBottom: 16 }}>
          <h2 style={styles.sectionTitle}>
            <span style={styles.step}>1</span>
            Thong tin thi sinh
          </h2>
          <div style={styles.fieldRow}>
            <div style={styles.field}>
              <label style={styles.label}>Ho va ten</label>
              <input
                className="input"
                placeholder="Nguyen Van A"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                disabled={Boolean(userId)}
              />
            </div>
            <div style={styles.field}>
              <label style={styles.label}>Email</label>
              <input
                className="input"
                placeholder="student@university.edu"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={Boolean(userId)}
              />
            </div>
          </div>

          {!userId ? (
            <button
              className="btn btn-ghost"
              onClick={handleRegisterUser}
              disabled={loading}
              style={{ marginTop: 12 }}
            >
              Xac nhan thong tin
            </button>
          ) : (
            <p style={{ color: "var(--color-success)", marginTop: 8, fontSize: 13 }}>
              Da dang ky thanh cong
            </p>
          )}
        </div>

        <div className="card fade-in" style={{ marginBottom: 16 }}>
          <h2 style={styles.sectionTitle}>
            <span style={styles.step}>2</span>
            URL bai thi
          </h2>
          <input
            className="input"
            placeholder="https://exam.example.edu/test/123"
            value={examUrl}
            onChange={(event) => setExamUrl(event.target.value)}
          />
          <p style={{ color: "var(--color-text-dim)", fontSize: 12, marginTop: 6 }}>
            Chi cac URL trong whitelist moi duoc phep mo.
          </p>
        </div>

        {error && <div style={styles.error}>{error}</div>}

        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "14px" }}
          onClick={handleStart}
          disabled={loading || !userId}
        >
          {loading ? "Đang xử lý..." : "Bắt đầu thi"}
        </button>

        {onTestMode && (
          <button
            className="btn btn-ghost"
            style={{ width: "100%", justifyContent: "center", marginTop: "12px", border: "1px dashed var(--color-border)" }}
            onClick={onTestMode}
          >
            🛠 Vào chế độ Test AI Monitor
          </button>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(135deg, #0d1117 0%, #0f1e3d 100%)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "32px 16px",
  },
  container: {
    width: "100%",
    maxWidth: 560,
  },
  header: {
    textAlign: "center",
    marginBottom: 32,
  },
  logo: {
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: 3,
    marginBottom: 8,
    color: "#9bc3ff",
  },
  title: {
    fontSize: 32,
    fontWeight: 700,
    margin: 0,
    background: "linear-gradient(90deg, #4f8ef7, #a78bfa)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
  subtitle: {
    color: "var(--color-text-muted)",
    marginTop: 6,
    fontSize: 14,
  },
  sectionTitle: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 15,
    fontWeight: 600,
    marginTop: 0,
    marginBottom: 14,
    color: "var(--color-text)",
  },
  step: {
    width: 24,
    height: 24,
    borderRadius: "50%",
    background: "var(--color-primary)",
    color: "#fff",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  fieldRow: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: "var(--color-text-muted)",
  },
  video: {
    width: "100%",
    maxWidth: 360,
    borderRadius: 8,
    border: "2px solid var(--color-primary)",
  },
  error: {
    background: "rgba(248,81,73,0.1)",
    border: "1px solid rgba(248,81,73,0.3)",
    borderRadius: 8,
    padding: "12px 16px",
    color: "var(--color-danger)",
    fontSize: 13,
    marginBottom: 16,
  },
};
