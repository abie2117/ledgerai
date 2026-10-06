'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

interface ConnectedAccount {
  id: string;
  plaid_item_id?: string;
  name: string;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  coa_category_id?: string | null;
}

interface TransferSource extends ConnectedAccount {
  plaid_items: { superseded_by_plaid_item_id: string };
}

interface LedgerAccount {
  id: string;
  name: string;
  coa_code?: string | null;
  account_type: 'asset' | 'liability';
}

interface Props {
  clientId: string;
  canManage: boolean;
}

function connectedLabel(account: ConnectedAccount) {
  const suffix = account.mask ? ` ••••${account.mask}` : '';
  const type = account.subtype || account.type;
  return `${account.name}${suffix}${type ? ` · ${type}` : ''}`;
}

function ledgerLabel(category: LedgerAccount) {
  return `${category.coa_code ? `${category.coa_code} · ` : ''}${category.name} · ${category.account_type}`;
}

export default function AccountingSetupPanel({ clientId, canManage }: Props) {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [categories, setCategories] = useState<LedgerAccount[]>([]);
  const [transferSources, setTransferSources] = useState<TransferSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newCode, setNewCode] = useState('');
  const [newType, setNewType] = useState<'asset' | 'liability'>('asset');

  const load = useCallback(async () => {
    if (!clientId) return;

    setLoading(true);
    setError('');

    try {
      const response = await fetch(
        `/api/accounting-setup?clientId=${encodeURIComponent(clientId)}`,
        { cache: 'no-store' },
      );
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || 'Unable to load accounting setup.');
      }

      setAccounts(result.accounts || []);
      setCategories(result.categories || []);
      setTransferSources(result.transferSources || []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load accounting setup.');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setCreatingFor(null);
      setMessage('');
      setError('');
      void load();
    });
    return () => { cancelled = true; };
  }, [load]);

  const categoryById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const mappedCount = accounts.filter((account) => account.coa_category_id).length;

  async function mutate(body: Record<string, unknown>) {
    const response = await fetch('/api/accounting-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, ...body }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || 'Unable to update account mapping.');
    }

    window.dispatchEvent(new CustomEvent('ledgerai:accounting-setup-changed', { detail: { clientId } }));
    return result;
  }

  async function mapAccount(accountId: string, categoryId: string) {
    if (!canManage || actingId || !categoryId) return;

    try {
      setActingId(accountId);
      setError('');
      setMessage('');
      await mutate({ action: 'map', accountId, categoryId });
      setMessage('Account mapping saved. Reconciliation eligibility has been updated.');
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Unable to save mapping.');
    } finally {
      setActingId(null);
    }
  }

  async function unmapAccount(accountId: string) {
    if (!canManage || actingId) return;
    if (!window.confirm('Remove this ledger mapping? Active journal history may prevent this change.')) return;

    try {
      setActingId(accountId);
      setError('');
      setMessage('');
      await mutate({ action: 'unmap', accountId });
      setMessage('Account mapping removed.');
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Unable to remove mapping.');
    } finally {
      setActingId(null);
    }
  }

  async function transferMapping(source: TransferSource, destination: ConnectedAccount) {
    if (!canManage || actingId || !source.coa_category_id) return;
    const category = categoryById.get(source.coa_category_id);
    if (!category || !window.confirm(
      `Transfer ${ledgerLabel(category)} from ${connectedLabel(source)} to ${connectedLabel(destination)}? Historical transactions stay with their original accounts. Both accounts must have zero active journals and zero reconciliations.`,
    )) return;
    try {
      setActingId(destination.id);
      setError('');
      setMessage('');
      await mutate({ action: 'transfer', accountId: destination.id,
        fromAccountId: source.id, categoryId: source.coa_category_id });
      setMessage('Ledger mapping transferred. Historical transactions and source statuses are preserved.');
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Unable to transfer mapping.');
    } finally {
      setActingId(null);
    }
  }

  async function createAndMap(accountId: string) {
    if (!canManage || actingId || !newName.trim()) return;

    try {
      setActingId(accountId);
      setError('');
      setMessage('');
      await mutate({
        action: 'create_and_map',
        accountId,
        name: newName.trim(),
        coaCode: newCode.trim(),
        accountType: newType,
      });
      setCreatingFor(null);
      setNewName('');
      setNewCode('');
      setNewType('asset');
      setMessage('Ledger account created and connected account mapped.');
      await load();
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'Unable to create ledger account.');
    } finally {
      setActingId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Accounting Setup</h2>
          <p className="mt-1 text-sm text-slate-400">
            Map each connected financial account to the ledger account that represents it in the books.
          </p>
        </div>
        <div className="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-300">
          {mappedCount} of {accounts.length} mapped
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        LedgerAI does not guess these mappings. Bank and savings accounts normally map to an Asset; credit cards and loans normally map to a Liability. Choose the account that matches the actual books.
      </p>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}
      {message && (
        <div className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
          {message}
        </div>
      )}

      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Loading accounting setup…</p>
      ) : accounts.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No connected accounts are available for this client.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {accounts.map((account) => {
            const mapped = account.coa_category_id
              ? categoryById.get(account.coa_category_id)
              : null;
            const isCreating = creatingFor === account.id;

            return (
              <div key={account.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_auto] lg:items-center">
                  <div>
                    <p className="font-medium text-slate-100">{connectedLabel(account)}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {mapped ? `Mapped to ${ledgerLabel(mapped)}` : 'Not mapped — reconciliation and journal posting are not ready for this account.'}
                    </p>
                  </div>

                  <select
                    value={account.coa_category_id || ''}
                    disabled={!canManage || !!actingId}
                    onChange={(event) => void mapAccount(account.id, event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
                  >
                    <option value="">Select ledger account</option>
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}
                        disabled={accounts.some((owner) => owner.id !== account.id && owner.coa_category_id === category.id)
                          || transferSources.some((owner) => owner.coa_category_id === category.id)}>
                        {ledgerLabel(category)}
                      </option>
                    ))}
                  </select>

                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={!canManage || !!actingId}
                      onClick={() => {
                        setCreatingFor(isCreating ? null : account.id);
                        setNewName(account.name);
                        setNewCode('');
                        setNewType(account.type === 'credit' || account.type === 'loan' ? 'liability' : 'asset');
                      }}
                      className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-50"
                    >
                      New ledger account
                    </button>
                    {account.coa_category_id && (
                      <button
                        type="button"
                        disabled={!canManage || !!actingId}
                        onClick={() => void unmapAccount(account.id)}
                        className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-400 hover:border-red-700 hover:text-red-300 disabled:opacity-50"
                      >
                        Unmap
                      </button>
                    )}
                  </div>
                </div>

                {!account.coa_category_id && transferSources
                  .filter((source) => source.plaid_items.superseded_by_plaid_item_id === account.plaid_item_id
                    && source.coa_category_id && categoryById.has(source.coa_category_id))
                  .map((source) => (
                    <div key={source.id} className="mt-3 rounded-lg border border-amber-800/50 p-3 text-sm text-slate-300">
                      <p>{ledgerLabel(categoryById.get(source.coa_category_id!)!)} is currently mapped to superseded account {connectedLabel(source)}.</p>
                      <button type="button" disabled={!canManage || !!actingId}
                        onClick={() => void transferMapping(source, account)}
                        className="mt-2 rounded-lg border border-cyan-700 px-3 py-2 text-xs font-semibold text-cyan-300 disabled:opacity-50">
                        Transfer existing ledger mapping
                      </button>
                    </div>
                  ))}

                {isCreating && (
                  <div className="mt-4 grid gap-3 border-t border-slate-800 pt-4 md:grid-cols-[minmax(0,1fr)_150px_160px_auto]">
                    <input
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder="Ledger account name"
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                    />
                    <input
                      value={newCode}
                      onChange={(event) => setNewCode(event.target.value)}
                      placeholder="COA code"
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                    />
                    <select
                      value={newType}
                      onChange={(event) => setNewType(event.target.value as 'asset' | 'liability')}
                      className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                    >
                      <option value="asset">Asset</option>
                      <option value="liability">Liability</option>
                    </select>
                    <button
                      type="button"
                      disabled={!newName.trim() || actingId === account.id}
                      onClick={() => void createAndMap(account.id)}
                      className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-500 disabled:opacity-50"
                    >
                      Create & map
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!canManage && (
        <p className="mt-4 text-xs text-amber-300">
          Owner, admin, or bookkeeper access is required to change accounting mappings.
        </p>
      )}
    </section>
  );
}
