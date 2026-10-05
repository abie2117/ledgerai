'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase-browser';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

interface LedgerCategory {
  id: string;
  name: string;
  coa_code?: string | null;
  account_type?: AccountType | null;
  normal_balance?: 'debit' | 'credit' | null;
}

interface JournalLine {
  description?: string | null;
  debit: number | string;
  credit: number | string;
  categories?: LedgerCategory | LedgerCategory[] | null;
  /* Supabase relationship inference can represent a joined relation as one row or an array. */
}

interface JournalEntry {
  id: string;
  entry_date: string;
  memo?: string | null;
  status: string;
  journal_lines?: JournalLine[];
}

interface AccountBalance {

  id: string;
  name: string;
  coaCode?: string | null;
  accountType: AccountType;
  debit: number;
  credit: number;
  balance: number;
}

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function ReportsContent() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const dashboardHref = clientId ? `/dashboard?clientId=${encodeURIComponent(clientId)}` : '/dashboard';
  const banksHref = clientId ? `/dashboard/banks?clientId=${encodeURIComponent(clientId)}` : '/dashboard/banks';
  const accountingHref = clientId ? `/dashboard/accounting?clientId=${encodeURIComponent(clientId)}` : '/dashboard/accounting';

  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(now.toISOString().slice(0, 10));
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(Boolean(clientId));
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!clientId) {
        setLoading(false);
        return;
      }

      setLoading(true);
      setError('');
      try {
        const { data, error: queryError } = await supabase
          .from('journal_entries')
          .select('id, entry_date, memo, status, journal_lines(description, debit, credit, categories(id, name, coa_code, account_type, normal_balance))')
          .eq('client_id', clientId)
          .in('status', ['posted', 'reversed'])
          .lte('entry_date', endDate)
          .order('entry_date', { ascending: true });

        if (queryError) throw queryError;
        if (!cancelled) setEntries((data || []) as unknown as JournalEntry[]);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Unable to load ledger reports.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [clientId, endDate]);

  function balancesFor(source: JournalEntry[]) {
    const balances = new Map<string, AccountBalance>();

    for (const entry of source) {
      for (const line of entry.journal_lines || []) {
        const category = Array.isArray(line.categories) ? line.categories[0] : line.categories;
        if (!category?.id || !category.account_type || !category.normal_balance) continue;

        const debit = Number(line.debit || 0);
        const credit = Number(line.credit || 0);
        const current = balances.get(category.id) || {
          id: category.id,
          name: category.name,
          coaCode: category.coa_code,
          accountType: category.account_type,
          debit: 0,
          credit: 0,
          balance: 0,
        };

        current.debit += debit;
        current.credit += credit;
        current.balance += category.normal_balance === 'debit' ? debit - credit : credit - debit;
        balances.set(category.id, current);
      }
    }

    return Array.from(balances.values()).sort((left, right) =>
      (left.coaCode || left.name).localeCompare(right.coaCode || right.name),
    );
  }

  const periodEntries = useMemo(
    () => entries.filter((entry) => entry.entry_date >= startDate && entry.entry_date <= endDate),
    [entries, startDate, endDate],
  );
  const periodBalances = useMemo(() => balancesFor(periodEntries), [periodEntries]);
  const asOfBalances = useMemo(() => balancesFor(entries), [entries]);

  const revenues = periodBalances.filter((account) => account.accountType === 'revenue');
  const expenses = periodBalances.filter((account) => account.accountType === 'expense');
  const totalRevenue = revenues.reduce((sum, account) => sum + account.balance, 0);
  const totalExpenses = expenses.reduce((sum, account) => sum + account.balance, 0);
  const netIncome = totalRevenue - totalExpenses;

  const assets = asOfBalances.filter((account) => account.accountType === 'asset');
  const liabilities = asOfBalances.filter((account) => account.accountType === 'liability');
  const equity = asOfBalances.filter((account) => account.accountType === 'equity');
  const cumulativeRevenue = asOfBalances.filter((account) => account.accountType === 'revenue').reduce((sum, account) => sum + account.balance, 0);
  const cumulativeExpenses = asOfBalances.filter((account) => account.accountType === 'expense').reduce((sum, account) => sum + account.balance, 0);
  const cumulativeEarnings = cumulativeRevenue - cumulativeExpenses;
  const totalAssets = assets.reduce((sum, account) => sum + account.balance, 0);
  const totalLiabilities = liabilities.reduce((sum, account) => sum + account.balance, 0);
  const totalEquity = equity.reduce((sum, account) => sum + account.balance, 0);
  const balanceDifference = totalAssets - (totalLiabilities + totalEquity + cumulativeEarnings);

  const trialDebit = asOfBalances.reduce((sum, account) => sum + account.debit, 0);
  const trialCredit = asOfBalances.reduce((sum, account) => sum + account.credit, 0);

  const generalLedgerRows = useMemo(() => {
    const rows: Array<{
      key: string;
      date: string;
      account: string;
      type: AccountType;
      memo: string;
      description: string;
      debit: number;
      credit: number;
    }> = [];

    for (const entry of periodEntries) {
      (entry.journal_lines || []).forEach((line, index) => {
        const category = Array.isArray(line.categories) ? line.categories[0] : line.categories;
        if (!category?.account_type) return;

        rows.push({
          key: `${entry.id}-${index}`,
          date: entry.entry_date,
          account: `${category.coa_code ? `${category.coa_code} · ` : ''}${category.name}`,
          type: category.account_type,
          memo: entry.memo || 'Journal entry',
          description: line.description || '—',
          debit: Number(line.debit || 0),
          credit: Number(line.credit || 0),
        });
      });
    }

    return rows;
  }, [periodEntries]);

  function rows(accounts: AccountBalance[]) {
    if (accounts.length === 0) return <p className="py-3 text-sm text-slate-500">No posted ledger activity.</p>;
    return accounts.map((account) => (
      <div key={account.id} className="flex items-center justify-between gap-4 border-b border-slate-800 py-2 text-sm last:border-0">
        <span className="text-slate-300">{account.coaCode ? `${account.coaCode} · ` : ''}{account.name}</span>
        <span className="font-medium text-slate-100">{money(account.balance)}</span>
      </div>
    ));
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
            <div>
              <h1 className="text-2xl font-extrabold tracking-[-0.03em] sm:text-3xl">Ledger<span className="text-cyan-400">AI</span></h1>
              <p className="mt-2 text-sm text-slate-400">Ledger-derived financial reports</p>
            </div>
            <a href={dashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-cyan-500/50 hover:text-white">Back to overview</a>
          </div>
          <nav className="flex flex-wrap items-center gap-1 border-t border-slate-800 bg-slate-950/35 px-5 py-2 sm:px-6">
            <a href={dashboardHref} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white">Overview</a>
            <a href={`${dashboardHref}#transactions`} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white">Transactions</a>
            <a href={banksHref} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white">Banking</a>
            <a href={accountingHref} className="rounded-lg px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white">Accounting</a>
            <span className="rounded-lg bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-300">Reports</span>
          </nav>
        </header>

        {!clientId ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
            <h2 className="text-lg font-semibold">Select a client first</h2>
            <p className="mt-2 text-sm text-slate-400">Choose the active client on the overview before opening reports.</p>
          </section>
        ) : (
          <>
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-sm text-slate-400">Period start<input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200" /></label>
                <label className="text-sm text-slate-400">Period end<input type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} className="mt-1 block rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200" /></label>
                <p className="text-xs text-slate-500">Reports use posted ledger history, including offsetting reversal entries. Draft journals are excluded.</p>
              </div>
            </section>

            {error && <div className="rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</div>}
            {loading ? <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">Loading ledger reports…</section> : (
              <>
                <div className="grid gap-6 xl:grid-cols-2">
                  <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                    <h2 className="text-xl font-semibold">Profit & Loss</h2>
                    <p className="mt-1 text-xs text-slate-500">{startDate} → {endDate}</p>
                    <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide text-slate-500">Revenue</h3>{rows(revenues)}
                    <div className="flex justify-between border-t border-slate-700 py-3 font-semibold"><span>Total revenue</span><span>{money(totalRevenue)}</span></div>
                    <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Expenses</h3>{rows(expenses)}
                    <div className="flex justify-between border-t border-slate-700 py-3 font-semibold"><span>Total expenses</span><span>{money(totalExpenses)}</span></div>
                    <div className="mt-2 flex justify-between rounded-xl bg-slate-950/60 p-4 text-lg font-bold"><span>Net income</span><span>{money(netIncome)}</span></div>
                  </section>

                  <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                    <h2 className="text-xl font-semibold">Balance Sheet</h2>
                    <p className="mt-1 text-xs text-slate-500">As of {endDate}</p>
                    <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide text-slate-500">Assets</h3>{rows(assets)}
                    <div className="flex justify-between border-t border-slate-700 py-3 font-semibold"><span>Total assets</span><span>{money(totalAssets)}</span></div>
                    <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Liabilities</h3>{rows(liabilities)}
                    <div className="flex justify-between border-t border-slate-700 py-3 font-semibold"><span>Total liabilities</span><span>{money(totalLiabilities)}</span></div>
                    <h3 className="mt-4 text-sm font-semibold uppercase tracking-wide text-slate-500">Equity</h3>{rows(equity)}
                    <div className="flex justify-between py-2 text-sm text-slate-300"><span>Cumulative earnings</span><span>{money(cumulativeEarnings)}</span></div>
                    <div className="flex justify-between border-t border-slate-700 py-3 font-semibold"><span>Total equity + earnings</span><span>{money(totalEquity + cumulativeEarnings)}</span></div>
                    <div className="mt-2 flex justify-between rounded-xl bg-slate-950/60 p-4 text-sm font-semibold"><span>Accounting equation difference</span><span>{money(balanceDifference)}</span></div>
                  </section>
                </div>

                <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                  <h2 className="text-xl font-semibold">General Ledger</h2>
                  <p className="mt-1 text-xs text-slate-500">{startDate} → {endDate} · posted ledger lines only</p>
                  {generalLedgerRows.length === 0 ? (
                    <p className="mt-4 text-sm text-slate-500">No posted ledger activity for this period.</p>
                  ) : (
                    <div className="mt-4 overflow-x-auto">
                      <table className="w-full min-w-[820px] text-sm">
                        <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                          <tr><th className="pb-2">Date</th><th className="pb-2">Account</th><th className="pb-2">Memo</th><th className="pb-2">Description</th><th className="pb-2 text-right">Debit</th><th className="pb-2 text-right">Credit</th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          {generalLedgerRows.map((row) => (
                            <tr key={row.key}>
                              <td className="py-2 text-slate-400">{row.date}</td>
                              <td className="py-2 text-slate-200">{row.account}</td>
                              <td className="py-2 text-slate-300">{row.memo}</td>
                              <td className="py-2 text-slate-400">{row.description}</td>
                              <td className="py-2 text-right text-slate-300">{row.debit > 0 ? money(row.debit) : '—'}</td>
                              <td className="py-2 text-right text-slate-300">{row.credit > 0 ? money(row.credit) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
                  <h2 className="text-xl font-semibold">Trial Balance</h2>
                  <p className="mt-1 text-xs text-slate-500">Posted ledger activity through {endDate}</p>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[620px] text-sm">
                      <thead className="text-left text-xs uppercase tracking-wide text-slate-500"><tr><th className="pb-2">Account</th><th className="pb-2">Type</th><th className="pb-2 text-right">Debits</th><th className="pb-2 text-right">Credits</th></tr></thead>
                      <tbody className="divide-y divide-slate-800">{asOfBalances.map((account) => <tr key={account.id}><td className="py-2 text-slate-200">{account.coaCode ? `${account.coaCode} · ` : ''}{account.name}</td><td className="py-2 capitalize text-slate-400">{account.accountType}</td><td className="py-2 text-right text-slate-300">{money(account.debit)}</td><td className="py-2 text-right text-slate-300">{money(account.credit)}</td></tr>)}</tbody>
                      <tfoot className="border-t border-slate-700 font-semibold"><tr><td className="pt-3" colSpan={2}>Totals</td><td className="pt-3 text-right">{money(trialDebit)}</td><td className="pt-3 text-right">{money(trialCredit)}</td></tr></tfoot>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}

export default function ReportsPage() {
  return <Suspense fallback={<main className="min-h-screen bg-slate-950" />}><ReportsContent /></Suspense>;
}
