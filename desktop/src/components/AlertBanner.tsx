/**
 * src/components/AlertBanner.tsx
 * ──────────────────────────────
 * Overlay banner shown when a critical/high violation is detected.
 * Automatically fades after 5 seconds.
 */

import React, { useEffect, useState } from "react";

interface Props {
  message: string;
  severity: "low" | "medium" | "high" | "critical";
  onDismiss?: () => void;
  updateKey?: number;
}

export default function AlertBanner({ message, severity, onDismiss, updateKey }: Props) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    setVisible(true);
    let t: NodeJS.Timeout;
    if (severity !== "critical") {
      t = setTimeout(() => {
        setVisible(false);
        if (onDismiss) onDismiss();
      }, 5000);
    }
    return () => {
      if (t) clearTimeout(t);
    };
  }, [message, severity, updateKey]); // Re-trigger timer when these change

  if (!visible) return null;

  const colors = {
    low:      { bg: "rgba(63,185,80,0.1)",  border: "rgba(63,185,80,0.3)",  text: "var(--color-success)" },
    medium:   { bg: "rgba(240,167,50,0.1)", border: "rgba(240,167,50,0.3)", text: "var(--color-warning)" },
    high:     { bg: "rgba(248,81,73,0.15)", border: "rgba(248,81,73,0.4)",  text: "var(--color-danger)" },
    critical: { bg: "rgba(255,77,109,0.2)", border: "rgba(255,77,109,0.6)", text: "var(--color-critical)" },
  };

  const icon = { low: "ℹ️", medium: "⚠️", high: "🚨", critical: "🔴" };
  const c = colors[severity];

  return (
    <div
      className="slide-in"
      style={{
        background: c.bg,
        border: `1px solid ${c.border}`,
        borderRadius: 8,
        padding: "10px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        boxShadow: severity === "critical" ? "0 0 20px rgba(255,77,109,0.4)" : "none",
      }}
    >
      <span style={{ fontSize: 13, color: c.text, display: "flex", alignItems: "center", gap: 6 }}>
        {icon[severity]} {message}
      </span>
      <button
        onClick={() => { setVisible(false); onDismiss?.(); }}
        style={{ background: "none", border: "none", cursor: "pointer", color: c.text, fontSize: 16 }}
      >
        ×
      </button>
    </div>
  );
}
