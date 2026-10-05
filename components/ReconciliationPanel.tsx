'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { supabase } from '@/lib/supabase-browser';

interface ConnectedAccount {
  id: string;
  name: string;
  mask?: string | null;
  type?: string | null;
  subtype?: string | null;
  coa_category_id?: string | null;
}

interface Reconciliation {
  id: string;
  account_id: string | null;
  period_start: string;
  period_end: string;
  status: 'in_progress' | 'completed' | 'needs_attention' | string;
  opening_statement_balance: number | null;
  opening_book_balance: number | null;
  closing_statement_balance: number | null;
  calculated_book_movement: number | null;
  calculated_book_closing_balance: number | null;
  reconciliation_difference: number | null;
  reconciled_at?: string | null;
  reopened_at?: string | null;
  reopen_reason?: string | null;
}

interface Props {
  clientId: string;
  canManage: boolean;
}

function money(value: number | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value));
}

function accountLabel(account: ConnectedAccount) {
  return account.mask
    ? `${account.name} ••••${account.mask}`
    : account.name;
}

export default function ReconciliationPanel({ clientId, canManage }: Props) {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [reconciliations, setReconciliations] = useState<Reconciliation[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [accountId, setAccountId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [openingStatementBalance, setOpeningStatementBalance] = useState('');
  const [openingBookBalance, setOpeningBookBalance] = useState('');
  const [closingStatementBalance, setClosingStatementBalance] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  async function load() {
    if (!clientId) return;

    setLoading(true);
    setError('');

    try {
      const [{ data: accountData, error: accountError }, { data: reconciliationData, error: reconciliationError }] =
        await Promise.all([
          supabase
            .from('accounts')
            .select('id, name, mask, type, subtype, coa_category_id, plaid_items!inner(client_id)')
            .eq('plaid_items.client_id', clientId)
            .order('name', { ascending: true }),
          supabase
            .from('reconciliations')
            .select('id, account_id, period_start, period_end, status, opening_statement_balance, opening_book_balance, closing_statement_balance, calculated_book_movement, calculated_book_closing_balance, reconciliation_difference, reconciled_at, reopened_at, reopen_reason')
            .eq('client_id', clientId)
            .order('period_end', { ascending: false }),
        ]);

      if (accountError) throw accountError;
      if (reconciliationError) throw reconciliationError;

      setAccounts((accountData || []) as unknown as ConnectedAccount[]);
      setReconciliations((reconciliationData || []) as Reconciliation[]);
    } catch (loadError: unknown) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Unable to load reconciliation data.',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setAccountId('');
    setEditingId(null);
    setMessage('');
    setError('');
    void load();
  }, [clientId]);

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );

  const mappedAccounts = accounts.filter((account) => account.coa_category_id);
  const unmappedAccounts = accounts.filter((account) => !account.coa_category_id);

  async function callAction(body: Record<string, unknown>) {
    const response = await fetch('/api/reconciliations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, ...body }),
    });
    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.error || 'Unable to update reconciliation.');
    }

    return result;
  }

  function clearForm() {
    setEditingId(null);
    setAccountId('');
    setPeriodStart('');
    setPeriodEnd('');
    setOpeningStatementBalance('');
    setOpeningBookBalance('');
    setClosingStatementBalance('');
  }

  async function handleStart(event: FormEvent) {
    event.preventDefault();
    if (!canManage || acting) return;

    try {
      setActing(true);
      setError('');
      setMessage('');

      await callAction({
        action: 'start',
        accountId,
        periodStart,
        periodEnd,
        openingStatementBalance,
        openingBookBalance,
        closingStatementBalance,
      });

      setMessage('Reconciliation started. Complete it only after the statement and book balances agree.');
      clearForm();
      await load();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to start reconciliation.');
    } finally {
      setActing(false);
    }
  }

  function beginBalanceEdit(reconciliation: Reconciliation) {
    setEditingId(reconciliation.id);
    setOpeningStatementBalance(String(reconciliation.opening_statement_balance ?? ''));
    setOpeningBookBalance(String(reconciliation.opening_book_balance ?? ''));
    setClosingStatementBalance(String(reconciliation.closing_statement_balance ?? ''));
    setError('');
    setMessage('');
  }

  async function saveBalances(reconciliationId: string) {
    if (!canManage || acting) return;

    try {
      setActing(true);
      setError('');
      setMessage('');

      await callAction({
        action: 'update_balances',
        reconciliationId,
        openingStatementBalance,
        openingBookBalance,
        closingStatementBalance,
      });

      setMessage('Statement and book balances updated.');
      clearForm();
      await load();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update balances.');
    } finally {
      setActing(false);
    }
  }

  async function complete(reconciliation: Reconciliation) {
    if (!canManage || acting) return;

    const confirmed = window.confirm(
      'Complete this reconciliation? LedgerAI will calculate the closing book balance from posted journal movement. Completion succeeds only at an exact zero difference.',
    );
    if (!confirmed) return;

    try {
      setActing(true);
      setError('');
      setMessage('');
      const result = await callAction({
        action: 'complete',
        reconciliationId: reconciliation.id,
      });

      setMessage(
        result.status === 'completed'
          ? `Reconciliation completed with zero difference. ${result.includedJournalCount} posted journal(s) were included.`
          : `Reconciliation needs attention. Difference: ${money(Number(result.difference))}.`,
      );
      await load();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to complete reconciliation.');
    } finally {
      setActing(false);
    }
  }

  async function reopen(reconciliation: Reconciliation) {
    if (!canManage || acting) return;

    const reason = window.prompt(
      'Why are you reopening this completed reconciliation? This reason is retained in the audit history.',
    );
    if (!reason?.trim()) return;

    try {
      setActing(true);
      setError('');
      setMessage('');
      await callAction({
        action: 'reopen',
        reconciliationId: reconciliation.id,
        reason: reason.trim(),
      });
      setMessage('Reconciliation reopened. Reconciled journal protection has been released for controlled correction.');
      await load();
    } catch (actionError: unknown) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to reopen reconciliation.');
    } finally {
      setActing(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-white">Account Reconciliation</h2>
          <p className="mt-1 text-sm text-slate-400">
            Reconcile posted book activity to an actual bank or credit-card statement.
          </p>
        </div>
        <span className="text-xs text-slate-500">Statement balances are entered manually</span>
      </div>

      {error && <p className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
      {message && <p className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300">{message}</p>}

      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Loading reconciliation controls...</p>
      ) : (
        <>
          {canManage && (
            <form onSubmit={handleStart} className="mt-5 grid gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4 md:grid-cols-2 lg:grid-cols-4">
              <label className="text-xs font-medium text-slate-400 lg:col-span-2">
                Connected account
                <select value={accountId} onChange={(event) => setAccountId(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                  <option value="">Select mapped account</option>
                  {mappedAccounts.map((account) => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
                </select>
              </label>
              <label className="text-xs font-medium text-slate-400">
                Period start
                <input type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
              </label>
              <label className="text-xs font-medium text-slate-400">
                Period end
                <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
              </label>
              <label className="text-xs font-medium text-slate-400">
                Statement opening balance
                <input type="number" step="0.01" value={openingStatementBalance} onChange={(event) => setOpeningStatementBalance(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
              </label>
              <label className="text-xs font-medium text-slate-400">
                Book opening balance
                <input type="number" step="0.01" value={openingBookBalance} onChange={(event) => setOpeningBookBalance(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
              </label>
              <label className="text-xs font-medium text-slate-400">
                Statement closing balance
                <input type="number" step="0.01" value={closingStatementBalance} onChange={(event) => setClosingStatementBalance(event.target.value)} required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
              </label>
              <div className="flex items-end">
                <button type="submit" disabled={acting || mappedAccounts.length === 0} className="w-full rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-40">
                  {acting ? 'Working...' : 'Start reconciliation'}
                </button>
              </div>
            </form>
          )}

          {unmappedAccounts.length > 0 && (
            <p className="mt-3 text-xs text-amber-300">
              {unmappedAccounts.length} connected account{unmappedAccounts.length === 1 ? ' is' : 's are'} not eligible yet because {unmappedAccounts.length === 1 ? 'it is' : 'they are'} not mapped to a client asset/liability chart-of-accounts entry.
            </p>
          )}

          {!canManage && (
            <p className="mt-4 text-sm text-slate-500">Reconciliation is read-only for your role. Owner, admin, or bookkeeper access is required to make accounting changes.</p>
          )}

          <div className="mt-5 space-y-3">
            {reconciliations.length === 0 ? (
              <p className="text-sm text-slate-500">No account reconciliations recorded for this client.</p>
            ) : reconciliations.map((reconciliation) => {
              const account = reconciliation.account_id ? accountById.get(reconciliation.account_id) : null;
              const editable = reconciliation.status === 'in_progress' || reconciliation.status === 'needs_attention';
              const editing = editingId === reconciliation.id;

              return (
                <div key={reconciliation.id} className="rounded-xl border border-slate-800 bg-slate-950/30 p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-white">{account ? accountLabel(account) : 'Connected account'}</p>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${reconciliation.status === 'completed' ? 'bg-emerald-500/10 text-emerald-300' : reconciliation.status === 'needs_attention' ? 'bg-amber-500/10 text-amber-300' : 'bg-cyan-500/10 text-cyan-300'}`}>
                          {reconciliation.status.replaceAll('_', ' ')}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{reconciliation.period_start} → {reconciliation.period_end}</p>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        {editable && <button type="button" disabled={acting} onClick={() => beginBalanceEdit(reconciliation)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:border-cyan-400 hover:text-cyan-300 disabled:opacity-40">Edit balances</button>}
                        {editable && <button type="button" disabled={acting} onClick={() => complete(reconciliation)} className="rounded-lg border border-emerald-500/50 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40">Calculate & complete</button>}
                        {reconciliation.status === 'completed' && <button type="button" disabled={acting} onClick={() => reopen(reconciliation)} className="rounded-lg border border-amber-500/50 px-3 py-1.5 text-xs font-semibold text-amber-300 hover:bg-amber-500/10 disabled:opacity-40">Reopen</button>}
                      </div>
                    )}
                  </div>

                  {editing ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-4">
                      <input aria-label="Statement opening balance" type="number" step="0.01" value={openingStatementBalance} onChange={(event) => setOpeningStatementBalance(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
                      <input aria-label="Book opening balance" type="number" step="0.01" value={openingBookBalance} onChange={(event) => setOpeningBookBalance(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
                      <input aria-label="Statement closing balance" type="number" step="0.01" value={closingStatementBalance} onChange={(event) => setClosingStatementBalance(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" />
                      <div className="flex gap-2">
                        <button type="button" disabled={acting} onClick={() => saveBalances(reconciliation.id)} className="rounded-lg bg-cyan-500 px-3 py-2 text-xs font-semibold text-slate-950 disabled:opacity-40">Save</button>
                        <button type="button" disabled={acting} onClick={clearForm} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 disabled:opacity-40">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
                      <div><p className="text-slate-500">Statement opening</p><p className="mt-1 font-medium text-slate-200">{money(reconciliation.opening_statement_balance)}</p></div>
                      <div><p className="text-slate-500">Book opening</p><p className="mt-1 font-medium text-slate-200">{money(reconciliation.opening_book_balance)}</p></div>
                      <div><p className="text-slate-500">Book movement</p><p className="mt-1 font-medium text-slate-200">{money(reconciliation.calculated_book_movement)}</p></div>
                      <div><p className="text-slate-500">Book closing</p><p className="mt-1 font-medium text-slate-200">{money(reconciliation.calculated_book_closing_balance)}</p></div>
                      <div><p className="text-slate-500">Statement closing</p><p className="mt-1 font-medium text-slate-200">{money(reconciliation.closing_statement_balance)}</p></div>
                      <div><p className="text-slate-500">Difference</p><p className={`mt-1 font-semibold ${Number(reconciliation.reconciliation_difference || 0) === 0 ? 'text-emerald-300' : 'text-amber-300'}`}>{money(reconciliation.reconciliation_difference)}</p></div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
