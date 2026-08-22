// components/ClientListTable.tsx
// Sorted so the client most in need of attention is never buried:
// error/revoked connections first, then by pending-review count, then
// alphabetically. Nothing here should require scrolling to find "what's
// broken right now."

import Link from "next/link";

export interface ClientSummary {
  id: string;
  businessName: string;
  status: "active" | "paused" | "offboarded";
  pendingCount: number;
  connectionStatus: "active" | "error" | "revoked" | "unconnected";
  lastSyncedAt: string | null;
}

interface ClientListTableProps {
  firmName: string;
  firmTier: string;
  clients: ClientSummary[];
}

const TIER_LABELS: Record<string, string> = {
  starter: "Starter",
  growth: "Growth",
  firm_scale: "Firm / Scale",
};

export function ClientListTable({ firmName, firmTier, clients }: ClientListTableProps) {
  const sorted = [...clients].sort((a, b) => {
    const brokenA = a.connectionStatus === "error" || a.connectionStatus === "revoked" ? 0 : 1;
    const brokenB = b.connectionStatus === "error" || b.connectionStatus === "revoked" ? 0 : 1;
    if (brokenA !== brokenB) return brokenA - brokenB;
    if (a.pendingCount !== b.pendingCount) return b.pendingCount - a.pendingCount;
    return a.businessName.localeCompare(b.businessName);
  });

  const needsAttention = clients.filter(
    (c) => c.connectionStatus === "error" || c.connectionStatus === "revoked"
  ).length;

  return (
    <div style={{ maxWidth: 960, margin: "0 auto", padding: "32px 24px" }}>
      <header style={{ marginBottom: 24, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {TIER_LABELS[firmTier] ?? firmTier} plan
          </div>
          <h1 className="ledger-heading" style={{ fontSize: 28, margin: "4px 0" }}>{firmName}</h1>
          <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>
            {needsAttention > 0
              ? `${needsAttention} connection${needsAttention === 1 ? "" : "s"} need${needsAttention === 1 ? "s" : ""} attention`
              : "All connections healthy"}
          </div>
        </div>
        <Link href="/clients/new" style={addClientBtnStyle}>
          + Add client
        </Link>
      </header>

      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {sorted.map((client) => (
            <ClientRow key={client.id} client={client} />
          ))}
        </div>
      )}
    </div>
  );
}

function ClientRow({ client }: { client: ClientSummary }) {
  const broken = client.connectionStatus === "error" || client.connectionStatus === "revoked";

  return (
    <Link
      href={`/clients/${client.id}/transactions`}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 4px",
        borderBottom: "1px solid var(--rule)",
        textDecoration: "none",
        color: "inherit",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          aria-hidden
          style={{
            width: 6,
            height: 36,
            borderRadius: 3,
            background: broken ? "var(--correct-accent)" : client.pendingCount > 0 ? "var(--review)" : "var(--confirm)",
          }}
        />
        <div>
          <div className="ledger-heading" style={{ fontSize: 16 }}>{client.businessName}</div>
          <ConnectionLabel client={client} />
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        {client.pendingCount > 0 && (
          <div style={{ textAlign: "right" }}>
            <div className="ledger-figure" style={{ fontSize: 18, color: "var(--review)" }}>
              {client.pendingCount}
            </div>
            <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>to review</div>
          </div>
        )}
        {client.status !== "active" && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--ink-soft)",
              border: "1px solid var(--rule)",
              borderRadius: 3,
              padding: "2px 8px",
              textTransform: "capitalize",
            }}
          >
            {client.status}
          </span>
        )}
        <span style={{ color: "var(--ink-soft)" }} aria-hidden>›</span>
      </div>
    </Link>
  );
}

function ConnectionLabel({ client }: { client: ClientSummary }) {
  if (client.connectionStatus === "unconnected") {
    return <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>No account connected yet</div>;
  }
  if (client.connectionStatus === "error" || client.connectionStatus === "revoked") {
    return (
      <div style={{ fontSize: 12, color: "var(--correct-accent)", fontWeight: 600 }}>
        {client.connectionStatus === "revoked" ? "Access revoked — reconnect needed" : "Connection error — reconnect needed"}
      </div>
    );
  }
  return (
    <div style={{ fontSize: 12, color: "var(--ink-soft)" }}>
      Synced {client.lastSyncedAt ? relativeTime(client.lastSyncedAt) : "recently"}
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "64px 24px",
        border: "1px dashed var(--rule)",
        borderRadius: "var(--radius-md)",
        color: "var(--ink-soft)",
      }}
    >
      <div className="ledger-heading" style={{ fontSize: 18, color: "var(--ink)", marginBottom: 6 }}>
        No clients yet
      </div>
      <div style={{ fontSize: 13, marginBottom: 16 }}>Add your first client to connect their accounts and start reviewing transactions.</div>
      <Link href="/clients/new" style={addClientBtnStyle}>+ Add client</Link>
    </div>
  );
}

const addClientBtnStyle: React.CSSProperties = {
  padding: "8px 16px",
  borderRadius: "var(--radius-sm)",
  background: "var(--confirm)",
  color: "white",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
