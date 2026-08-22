// components/ConfidenceStamp.tsx
// The signature element of the review console: a notched meter that fills
// like ink to show the AI's confidence in a category guess, and a stamp
// mark that lands when a bookkeeper confirms it — a nod to the paper
// ledger sign-off this product is quietly replacing.

"use client";

import { useState } from "react";

interface ConfidenceStampProps {
  confidence: number; // 0–1
  status: "pending_review" | "confirmed" | "flagged";
}

export function ConfidenceMeter({ confidence }: { confidence: number }) {
  const notches = 5;
  const filled = Math.round(confidence * notches);

  const color =
    confidence >= 0.85 ? "var(--confirm)" : confidence >= 0.6 ? "var(--review)" : "var(--correct-accent)";

  return (
    <div
      style={{ display: "inline-flex", gap: 2, alignItems: "center" }}
      role="img"
      aria-label={`AI confidence ${Math.round(confidence * 100)} percent`}
      title={`${Math.round(confidence * 100)}% confidence`}
    >
      {Array.from({ length: notches }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 12,
            borderRadius: 1,
            background: i < filled ? color : "var(--rule)",
            transition: "background 200ms ease",
          }}
        />
      ))}
    </div>
  );
}

export function ConfirmedStamp() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        fontFamily: "var(--font-display)",
        fontWeight: 600,
        fontSize: 12,
        color: "var(--confirm)",
        border: "1px solid var(--confirm)",
        borderRadius: 2,
        padding: "2px 8px",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        transform: "rotate(-2deg)",
        animation: "stampIn 180ms ease-out",
      }}
      onAnimationEnd={() => setVisible(true)}
    >
      ✓ Confirmed
      <style jsx>{`
        @keyframes stampIn {
          0% { opacity: 0; transform: rotate(-2deg) scale(1.4); }
          100% { opacity: 1; transform: rotate(-2deg) scale(1); }
        }
      `}</style>
    </span>
  );
}

export function StatusBadge({ status }: { status: ConfidenceStampProps["status"] }) {
  const styles: Record<string, { bg: string; fg: string; label: string }> = {
    pending_review: { bg: "var(--review-bg)", fg: "var(--review)", label: "Needs review" },
    confirmed: { bg: "var(--confirm-bg)", fg: "var(--confirm)", label: "Confirmed" },
    flagged: { bg: "var(--correct-accent-bg)", fg: "var(--correct-accent)", label: "Flagged" },
  };
  const s = styles[status];
  return (
    <span
      style={{
        background: s.bg,
        color: s.fg,
        fontSize: 11,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: "var(--radius-sm)",
        letterSpacing: "0.02em",
      }}
    >
      {s.label}
    </span>
  );
}
