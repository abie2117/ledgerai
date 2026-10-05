'use client';

import { useEffect, useRef, useState } from 'react';
import PlaidLinkButton from '@/components/PlaidLinkButton';

interface Connection {
  connectionRef: string;
  label: string;
  status: string;
  financialSourceStatus: string;
  supersededByConnectionRef: string | null;
  accountCount: number;
  connectedAt: string;
  lastSyncedAt: string | null;
}

interface ConnectedBanksPanelProps {
  clientId: string;
  refreshKey: number;
  onTransactionsReload: () => void;
  mode?: 'summary' | 'management';
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

export default function ConnectedBanksPanel({ clientId, refreshKey, onTransactionsReload, mode = 'summary' }: ConnectedBanksPanelProps) {
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [resolvingReference, setResolvingReference] = useState<string | null>(null);
  const [retainedReferences, setRetainedReferences] = useState<Record<string, string>>({});
  const [resolutionMessage, setResolutionMessage] = useState('');
  const [refreshStates, setRefreshStates] = useState<Record<string, RefreshState>>({});
  const [expandedClientId, setExpandedClientId] = useState<string | null>(null);
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

  const isCurrentLoad = loadState.clientId === clientId && loadState.refreshKey === refreshKey && loadState.inventoryRevision === inventoryRevision;
  const isLoading = !isCurrentLoad || loadState.status === 'loading';
  const hasError = isCurrentLoad && loadState.status === 'error';
  const connections = isCurrentLoad && loadState.status === 'success' ? loadState.connections : [];
  const showAll = expandedClientId === clientId;
  const visibleConnections = showAll ? connections : connections.slice(0, 6);
  const connectedCount = connections.filter((connection) => connection.status === 'active').length;
  const attentionCount = connections.filter((connection) => connection.status === 'error').length;
  const unavailableCount = connections.length - connectedCount - attentionCount;
  const isManagement = mode === 'management';

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


  async function supersedeConnection(connection: Connection) {
    const retainedConnectionRef = retainedReferences[connection.connectionRef];
    if (!retainedConnectionRef || resolvingReference) return;
    const retained = connections.find((item) => item.connectionRef === retainedConnectionRef);
    if (!retained) return;
    if (!window.confirm(`Exclude this bank source from financial activity and retain "${retained.label}" instead? Historical records remain available for audit. This cannot be treated as a simple display change.`)) return;
    try {
      setResolvingReference(connection.connectionRef);
      setResolutionMessage('');
      const response = await fetch('/api/plaid/source-resolution', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, connectionRef: connection.connectionRef, retainedConnectionRef }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Unable to supersede bank source.');
      setResolutionMessage('Financial source superseded. Historical records were preserved and the retained source remains active.');
      setInventoryRevision((revision) => revision + 1);
      onTransactionsReload();
    } catch (error) {
      setResolutionMessage(error instanceof Error ? error.message : 'Unable to supersede bank source.');
    } finally {
      setResolvingReference(null);
    }
  }

  async function handleReconnected(connection: Connection) {
    setRefreshStates((s) => ({ ...s, [connection.connectionRef]: 'idle' }));
    await refreshConnection(connection);
  }

  return (
    <section aria-labelledby="connected-banks-title" aria-busy={isLoading} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="connected-banks-title" className="text-lg font-semibold text-white">{isManagement ? 'Bank management' : 'Connected banks'}</h2>
          {!isLoading && !hasError && connections.length > 0 && !isManagement && (
            <p className="mt-1 text-sm text-slate-400">{connections.length} total · {connectedCount} connected{attentionCount > 0 ? ` · ${attentionCount} need${attentionCount === 1 ? 's' : ''} attention` : ''}{unavailableCount > 0 ? ` · ${unavailableCount} unavailable` : ''}</p>
          )}
          {isManagement && <p className="mt-1 text-sm text-slate-400">Review, refresh, and repair this client&apos;s bank connections.</p>}
        </div>
        {!isLoading && !hasError && connections.length > 0 && !isManagement && (
          <a href={`/dashboard/banks?clientId=${encodeURIComponent(clientId)}`} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 transition hover:border-emerald-500/50 hover:text-white">Manage banks</a>
        )}
      </div>

      {isLoading ? <p role="status" className="mt-4 text-sm text-slate-400">Loading connected banks...</p>
        : hasError ? <p role="alert" className="mt-4 text-sm text-red-300">Unable to load connected banks.</p>
        : connections.length === 0 ? <p className="mt-4 text-sm text-slate-400">No bank connections yet.</p>
        : !isManagement ? (
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 font-medium text-emerald-300">{connectedCount} connected</span>
            {attentionCount > 0 && <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 font-medium text-amber-200">{attentionCount} need{attentionCount === 1 ? 's' : ''} attention</span>}
            {unavailableCount > 0 && <span className="rounded-full border border-slate-700 bg-slate-800 px-3 py-1.5 font-medium text-slate-300">{unavailableCount} unavailable</span>}
          </div>
        ) : <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
            <p className="text-sm font-medium text-slate-200">Connections</p>
            <span className="text-xs text-slate-500">{connections.length} connection{connections.length === 1 ? '' : 's'}</span>
          </div>
          {resolutionMessage && <p role="status" className="mt-4 text-sm text-slate-300">{resolutionMessage}</p>}
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
                <div className="mt-3 text-xs text-slate-400">Financial source: <span className="font-semibold text-slate-200">{connection.financialSourceStatus === 'active' ? 'Active' : connection.financialSourceStatus === 'pending_review' ? 'Review required' : 'Superseded'}</span></div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  {reconnectRequired && loadState.clientRef ? (
                    <PlaidLinkButton reconnectClientRef={loadState.clientRef} reconnectConnectionRef={connection.connectionRef} reconnectLabel="Reconnect" onReconnected={() => handleReconnected(connection)} />
                  ) : (
                    <button type="button" onClick={() => void refreshConnection(connection)} disabled={refreshDisabled} className="rounded-lg border border-emerald-500/30 px-3 py-2 text-xs font-semibold text-emerald-200 transition hover:border-emerald-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
                      {refreshState === 'refreshing' ? 'Refreshing...' : refreshState === 'success' ? 'Refreshed' : refreshState === 'failed' ? 'Retry refresh' : connection.status === 'revoked' ? 'Unavailable' : 'Refresh'}
                    </button>
                  )}
                  {refreshState === 'success' && <p role="status" className="text-xs text-emerald-300">Bank transactions refreshed.</p>}
                  {reconnectRequired && <p role="alert" className="text-xs text-amber-200">Reauthentication is required before this connection can refresh.</p>}
                  {refreshState === 'failed' && <p role="alert" className="text-xs text-red-300">Unable to refresh this connection. Try again.</p>}
                </div>
                {connection.financialSourceStatus !== 'superseded' && connections.filter((item) => item.connectionRef !== connection.connectionRef && item.status === 'active' && item.financialSourceStatus === 'active').length > 0 && (
                  <div className="mt-4 border-t border-slate-800 pt-4">
                    <p className="text-xs font-medium text-slate-300">Source resolution</p>
                    <div className="mt-2 flex flex-col gap-2">
                      <select value={retainedReferences[connection.connectionRef] || ''} onChange={(event) => setRetainedReferences((current) => ({ ...current, [connection.connectionRef]: event.target.value }))} className="min-w-0 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200">
                        <option value="">Choose source to retain</option>
                        {connections.filter((item) => item.connectionRef !== connection.connectionRef && item.status === 'active' && item.financialSourceStatus === 'active').map((item) => <option key={item.connectionRef} value={item.connectionRef}>{item.label} · {item.accountCount} account{item.accountCount === 1 ? '' : 's'} · connected {formatDate(item.connectedAt)}</option>)}
                      </select>
                      <button type="button" disabled={!retainedReferences[connection.connectionRef] || !!resolvingReference} onClick={() => void supersedeConnection(connection)} className="self-start rounded-lg border border-amber-500/40 px-3 py-2 text-xs font-semibold text-amber-200 hover:border-amber-400 disabled:cursor-not-allowed disabled:opacity-50">
                        {resolvingReference === connection.connectionRef ? 'Resolving...' : 'Supersede this source'}
                      </button>
                    </div>
                  </div>
                )}
              </li>;
            })}
          </ul>
          {connections.length > 6 && (
            <div className="mt-4 flex justify-center">
              <button type="button" onClick={() => setExpandedClientId(showAll ? null : clientId)} className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:border-slate-500 hover:text-white">
                {showAll ? 'Show fewer' : `Show all ${connections.length} connections`}
              </button>
            </div>
          )}
        </>}
    </section>
  );
}
