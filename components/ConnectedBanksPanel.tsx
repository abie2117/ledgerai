'use client';

import { useEffect, useRef, useState } from 'react';
import PlaidLinkButton from '@/components/PlaidLinkButton';

interface Connection {
  connectionRef: string;
  label: string;
  status: string;
  accountCount: number;
  connectedAt: string;
  lastSyncedAt: string | null;
}

interface ConnectedBanksPanelProps {
  clientId: string;
  refreshKey: number;
  onTransactionsReload: () => void;
}

type RefreshState = 'idle' | 'refreshing' | 'success' | 'reconnect_required' | 'failed';

interface ConnectionLoadState {
  clientId: string;
  refreshKey: number;
  inventoryRevision: number;
  status: 'loading' | 'success' | 'error';
  clientRef: string | null;
  connections: Connection[];
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function getStatusPresentation(status: string) {
  if (status === 'active') return { label: 'Connected', className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' };
  if (status === 'error') return { label: 'Needs attention', className: 'border-amber-500/30 bg-amber-500/10 text-amber-200' };
  if (status === 'revoked') return { label: 'Disconnected', className: 'border-slate-600 bg-slate-800 text-slate-300' };
  return { label: 'Status unavailable', className: 'border-slate-600 bg-slate-800 text-slate-300' };
}

export default function ConnectedBanksPanel({ clientId, refreshKey, onTransactionsReload }: ConnectedBanksPanelProps) {
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const [showAll, setShowAll] = useState(false);
  const refreshingReferences = useRef(new Set<string>());
  const [loadState, setLoadState] = useState<ConnectionLoadState>({
    clientId: '', refreshKey: -1, inventoryRevision: -1, status: 'loading', clientRef: null, connections: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    async function loadConnections() {
      try {
        const response = await fetch(`/api/plaid/connections?client_id=${encodeURIComponent(clientId)}`, { credentials: 'include', signal: controller.signal });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || typeof result.clientRef !== 'string' || !Array.isArray(result.connections)) throw new Error();
        if (current) setLoadState({ clientId, refreshKey, inventoryRevision, status: 'success', clientRef: result.clientRef, connections: result.connections });
      } catch {
        if (current && !controller.signal.aborted) setLoadState({ clientId, refreshKey, inventoryRevision, status: 'error', clientRef: null, connections: [] });
      }
    }
    void loadConnections();
    return () => { current = false; controller.abort(); };
  }, [clientId, refreshKey, inventoryRevision]);

  useEffect(() => { setShowAll(false); }, [clientId]);

  const isCurrentLoad = loadState.clientId === clientId && loadState.refreshKey === refreshKey && loadState.inventoryRevision === inventoryRevision;
  const isLoading = !isCurrentLoad || loadState.status === 'loading';
  const hasError = isCurrentLoad && loadState.status === 'error';
  const connections = isCurrentLoad && loadState.status === 'success' ? loadState.connections : [];
  const visibleConnections = showAll ? connections : connections.slice(0, 6);

  async function refreshConnection(connection: Connection) {
    const connectionRef = connection.connectionRef;
    const clientRef = loadState.clientRef;
    if (!clientRef || refreshingReferences.current.has(connectionRef)) return;
    refreshingReferences.current.add(connectionRef);
    setRefreshStates((s) => ({ ...s, [connectionRef]: 'refreshing' }));
    try {
      const response = await fetch('/api/plaid/connections/refresh', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientRef, connectionRef }),
      });
      const result = await response.json().catch(() => null);
      if (result?.outcome === 'reconnect_required') {
        setRefreshStates((s) => ({ ...s, [connectionRef]: 'reconnect_required' }));
        setInventoryRevision((r) => r + 1);
        return;
      }
      if (!response.ok || result?.outcome !== 'success') throw new Error();
      setRefreshStates((s) => ({ ...s, [connectionRef]: 'success' }));
      setInventoryRevision((r) => r + 1);
      onTransactionsReload();
    } catch {
      setRefreshStates((s) => ({ ...s, [connectionRef]: 'failed' }));
    } finally {
      refreshingReferences.current.delete(connectionRef);
    }
  }

  async function handleReconnected(connection: Connection) {
    setRefreshStates((s) => ({ ...s, [connection.connectionRef]: 'idle' }));
    await refreshConnection(connection);
  }

  return (
    <section aria-labelledby="connected-banks-title" aria-busy={isLoading} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="connected-banks-title" className="text-lg font-semibold text-white">Connected banks</h2>
        {!isLoading && !hasError && connections.length > 0 && <span className="text-xs text-slate-500">{connections.length} connection{connections.length === 1 ? '' : 's'}</span>}
      </div>

      {isLoading ? <p role="status" className="mt-4 text-sm text-slate-400">Loading connected banks...</p>
        : hasError ? <p role="alert" className="mt-4 text-sm text-red-300">Unable to load connected banks.</p>
        : connections.length === 0 ? <p className="mt-4 text-sm text-slate-400">No bank connections yet.</p>
        : <>
          <ul className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {visibleConnections.map((connection) => {
              const status = getStatusPresentation(connection.status);
              const refreshState = refreshStates[connection.connectionRef] || 'idle';
              const reconnectRequired = refreshState === 'reconnect_required' || connection.status === 'error';
              const refreshDisabled = refreshState === 'refreshing' || reconnectRequired || connection.status !== 'active';
              return <li key={connection.connectionRef} className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="min-w-0 break-words text-sm font-semibold text-white">{connection.label}</h3>
                  <span className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}>{status.label}</span>
                </div>
                <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div><dt className="text-slate-500">Accounts</dt><dd className="mt-0.5 text-slate-300">{connection.accountCount} {connection.accountCount === 1 ? 'account' : 'accounts'}</dd></div>
                  <div><dt className="text-slate-500">Connected</dt><dd className="mt-0.5 text-slate-300">{formatDate(connection.connectedAt)}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-slate-500">Last synced</dt><dd className="mt-0.5 text-slate-300">{connection.lastSyncedAt ? formatDate(connection.lastSyncedAt) : 'Not synced yet'}</dd></div>
                </dl>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {reconnectRequired && loadState.clientRef ? (
                    <PlaidLinkButton
                      reconnectClientRef={loadState.clientRef}
                      reconnectConnectionRef={connection.connectionRef}
                      reconnectLabel="Reconnect"
                      onReconnected={() => handleReconnected(connection)}
                    />
                  ) : (
                    <button type="button" onClick={() => void refreshConnection(connection)} disabled={refreshDisabled} className="rounded-lg border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                      {refreshState === 'refreshing' ? 'Refreshing...' : refreshState === 'success' ? 'Refreshed' : refreshState === 'failed' ? 'Retry refresh' : connection.status === 'revoked' ? 'Unavailable' : 'Refresh'}
                    </button>
                  )}
                  {refreshState === 'success' && <p role="status" className="text-xs text-emerald-300">Bank transactions refreshed.</p>}
                  {reconnectRequired && <p role="alert" className="text-xs text-amber-200">Reauthentication is required before this connection can refresh.</p>}
                  {refreshState === 'failed' && <p role="alert" className="text-xs text-red-300">Unable to refresh this connection. Try again.</p>}
                </div>
              </li>;
            })}
          </ul>
          {connections.length > 6 && (
            <div className="mt-4 flex justify-center">
              <button type="button" onClick={() => setShowAll((value) => !value)} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white">
                {showAll ? 'Show fewer' : `Show all ${connections.length} connections`}
              </button>
            </div>
          )}
        </>}
    </section>
  );
}
