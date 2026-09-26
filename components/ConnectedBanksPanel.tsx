'use client';

import { useEffect, useState } from 'react';

interface Connection {
  key: string;
  label: string;
  status: string;
  accountCount: number;
  connectedAt: string;
  lastSyncedAt: string | null;
}

interface ConnectedBanksPanelProps {
  clientId: string;
  refreshKey: number;
}

interface ConnectionLoadState {
  clientId: string;
  refreshKey: number;
  status: 'loading' | 'success' | 'error';
  connections: Connection[];
}

function formatDate(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Date unavailable';
  }

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getStatusPresentation(status: string) {
  if (status === 'active') {
    return {
      label: 'Connected',
      className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    };
  }

  if (status === 'error') {
    return {
      label: 'Needs attention',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    };
  }

  if (status === 'revoked') {
    return {
      label: 'Disconnected',
      className: 'border-slate-600 bg-slate-800 text-slate-300',
    };
  }

  return {
    label: 'Status unavailable',
    className: 'border-slate-600 bg-slate-800 text-slate-300',
  };
}

export default function ConnectedBanksPanel({
  clientId,
  refreshKey,
}: ConnectedBanksPanelProps) {
  const [loadState, setLoadState] = useState<ConnectionLoadState>({
    clientId: '',
    refreshKey: -1,
    status: 'loading',
    connections: [],
  });

  useEffect(() => {
    const controller = new AbortController();
    let isCurrentRequest = true;

    async function loadConnections() {
      try {
        const response = await fetch(
          `/api/plaid/connections?client_id=${encodeURIComponent(clientId)}`,
          {
            credentials: 'include',
            signal: controller.signal,
          },
        );
        const result = await response.json().catch(() => null);

        if (
          !response.ok ||
          !result ||
          !Array.isArray(result.connections)
        ) {
          throw new Error('Unable to load connected banks.');
        }

        if (isCurrentRequest) {
          setLoadState({
            clientId,
            refreshKey,
            status: 'success',
            connections: result.connections as Connection[],
          });
        }
      } catch {
        if (isCurrentRequest && !controller.signal.aborted) {
          setLoadState({
            clientId,
            refreshKey,
            status: 'error',
            connections: [],
          });
        }
      }
    }

    void loadConnections();

    return () => {
      isCurrentRequest = false;
      controller.abort();
    };
  }, [clientId, refreshKey]);

  const isCurrentLoad =
    loadState.clientId === clientId &&
    loadState.refreshKey === refreshKey;
  const isLoading = !isCurrentLoad || loadState.status === 'loading';
  const hasError = isCurrentLoad && loadState.status === 'error';
  const connections =
    isCurrentLoad && loadState.status === 'success'
      ? loadState.connections
      : [];

  return (
    <section
      aria-labelledby="connected-banks-title"
      aria-busy={isLoading}
      className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id="connected-banks-title"
          className="text-lg font-semibold text-white"
        >
          Connected banks
        </h2>
        {!isLoading && !hasError && connections.length > 0 && (
          <span className="text-xs text-slate-500">
            {connections.length} connection{connections.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {isLoading ? (
        <p role="status" className="mt-4 text-sm text-slate-400">
          Loading connected banks...
        </p>
      ) : hasError ? (
        <p role="alert" className="mt-4 text-sm text-red-300">
          Unable to load connected banks.
        </p>
      ) : connections.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">
          No bank connections yet.
        </p>
      ) : (
        <ul className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
          {connections.map((connection) => {
            const status = getStatusPresentation(connection.status);

            return (
              <li
                key={connection.key}
                className="min-w-0 rounded-xl border border-slate-800 bg-slate-950/70 p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h3 className="min-w-0 break-words text-sm font-semibold text-white">
                    {connection.label}
                  </h3>
                  <span
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${status.className}`}
                  >
                    {status.label}
                  </span>
                </div>

                <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Accounts</dt>
                    <dd className="mt-0.5 text-slate-300">
                      {connection.accountCount}{' '}
                      {connection.accountCount === 1 ? 'account' : 'accounts'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Connected</dt>
                    <dd className="mt-0.5 text-slate-300">
                      {formatDate(connection.connectedAt)}
                    </dd>
                  </div>
                  <div className="sm:col-span-2">
                    <dt className="text-slate-500">Last synced</dt>
                    <dd className="mt-0.5 text-slate-300">
                      {connection.lastSyncedAt
                        ? formatDate(connection.lastSyncedAt)
                        : 'Not synced yet'}
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
