/**
 * src/components/ViolationList.tsx
 * ──────────────────────────────────
 * Scrollable list of recorded violations with severity badges.
 */

import React from "react";
import { ViolationEvent } from "../hooks/useViolations";

interface Props {
  violations: ViolationEvent[];
}

const EVENT_LABELS: Record<string, string> = {
  tab_switch: "Chuyển ứng dụng",
  fullscreen_exit: "Thoát toàn màn hình",
  url_blocked: "Truy cập URL bị chặn",
  popup_attempt: "Cố mở tab/popup",
  devtools_opened: "Mở DevTools",
  no_face: "Không thấy khuôn mặt",
  multiple_faces: "Nhiều khuôn mặt",
  identity_mismatch: "Không khớp danh tính",
  speech_detected: "Phát hiện giọng nói",
  multiple_voices: "Nhiều nguồn giọng",
  voice_overlap: "Chồng giọng",
  rapid_voice_change: "Thay đổi giọng đột ngột",
  camera_unavailable: "Camera không hoạt động",
  mic_unavailable: "Mic không hoạt động",
  app_focus_lost: "Mất focus cửa sổ",
  app_close_attempt: "Cố đóng ứng dụng",
};

export default function ViolationList({ violations }: Props) {
  if (violations.length === 0) {
    return (
      <div style={styles.empty}>
        ✓ Chưa có vi phạm nào được ghi nhận
      </div>
    );
  }

  return (
    <div style={styles.list}>
      {violations.slice(0, 50).map(v => (
        <div key={v.id} className="fade-in" style={styles.item}>
          <div style={styles.itemLeft}>
            <span className={`badge badge-${v.severity}`}>{v.severity}</span>
            <span style={styles.type}>
              {EVENT_LABELS[v.eventType] || v.eventType}
            </span>
          </div>
          <span style={styles.time}>
            {v.timestamp.toLocaleTimeString("vi-VN")}
          </span>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    maxHeight: 280,
    overflowY: "auto",
  },
  item: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    background: "var(--color-surface-2)",
    borderRadius: 6,
    border: "1px solid var(--color-border)",
  },
  itemLeft: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  type: {
    fontSize: 12,
    color: "var(--color-text)",
  },
  time: {
    fontSize: 11,
    color: "var(--color-text-dim)",
    fontFamily: "var(--font-mono)",
  },
  empty: {
    textAlign: "center",
    color: "var(--color-success)",
    fontSize: 13,
    padding: "20px 0",
  },
};
