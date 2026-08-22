// components/PlaidLinkButton.tsx
// Thin wrapper around react-plaid-link. Fetches a link_token for this
// client, opens Plaid's hosted UI (bank login happens entirely inside
// Plaid's iframe — this app never sees or touches bank credentials),
// then exchanges the resulting public_token on success.

"use client";

import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";

interface PlaidLinkButtonProps {
  clientId: string;
  onConnected: () => void;
}

export function PlaidLinkButton({ clientId, onConnected }: PlaidLinkButtonProps) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "connecting" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch("/api/plaid/link-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        if (data.linkToken) {
          setLinkToken(data.linkToken);
          setStatus("idle");
        } else {
          setStatus("error");
        }
      })
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      setStatus("connecting");
      try {
        const res = await fetch("/api/plaid/exchange", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ publicToken, clientId }),
        });
        if (!res.ok) throw new Error("exchange failed");
        onConnected();
      } catch {
        setStatus("error");
      }
    },
    [clientId, onConnected]
  );

  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess,
  });

  if (status === "error") {
    return (
      <div style={{ color: "var(--correct-accent)", fontSize: 13 }}>
        Couldn't start the connection. Refresh and try again.
      </div>
    );
  }

  return (
    <button
      onClick={() => open()}
      disabled={!ready || !linkToken || status === "connecting"}
      style={{
        padding: "10px 20px",
        borderRadius: "var(--radius-sm)",
        border: "none",
        background: "var(--confirm)",
        color: "white",
        fontWeight: 600,
        fontSize: 14,
        cursor: ready ? "pointer" : "not-allowed",
        opacity: ready ? 1 : 0.6,
      }}
    >
      {status === "connecting" ? "Connecting…" : status === "loading" ? "Preparing…" : "Connect a bank account"}
    </button>
  );
}
