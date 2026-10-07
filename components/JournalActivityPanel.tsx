'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase-browser';

interface JournalLine {
  id: string;
  description?: string | null;
  debit: number | string;
  credit: number | string;
  categories?: { name?: string | null; coa_code?: string | null } | null;
}

interface JournalEntry {
  id: string;
  transaction_id?: string | null;
  entry_date: string;
  memo?: string | null;
  status: 'draft' | 'posted' | 'reversed' | string;
  posted_at?: string | null;
  reversed_at?: string | null;
  reversal_of_journal_entry_id?: string | null;
  journal_lines?: JournalLine[];
}

interface Props {
  clientId: string;
}

function money(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

export default function JournalActivityPanel({ clientId }: Props) {
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!clientId) return;
      setLoading(true);
      setError('');

      try {
        const { data, error: queryError } = await supabase
          .from('journal_entries')
          .select('id, transaction_id, entry_date, memo, status, posted_at, reversed_at, reversal_of_journal_entry_id, journal_lines(id, description, debit, credit, categories(name, coa_code))')
          .eq('client_id', clientId)
          .order('entry_date', { ascending: false })
          .limit(50);

        if (queryError) throw queryError;
        if (!cancelled) setEntries((data || []) as JournalEntry[]);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load journal activity.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [clientId]);

  const visibleEntries = useMemo(
    () => statusFilter === 'all' ? entries : entries.filter((entry) => entry.status === statusFilter),
    [entries, statusFilter],
  );

  const postedCount = entries.filter((entry) => entry.status === 'posted').length;
  const reversedCount = entries.filter((entry) => entry.status === 'reversed').length;
  const draftCount = entries.filter((entry) => entry.status === 'draft').length;

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-white">Journal Activity</h2>
          <p className="mt-1 text-sm text-slate-400">
            Read-only ledger history for posted, reversed, and draft journal entries.
          </p>
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
        >
          <option value="all">All statuses</option>
          <option value="posted">Posted</option>
          <option value="reversed">Reversed</option>
          <option value="draft">Draft</option>
        </select>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{postedCount} posted</span>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{reversedCount} reversed</span>
        <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{draftCount} draft</span>
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Loading journal activity…</p>
      ) : visibleEntries.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">
          {entries.length === 0 ? 'No journal entries have been created for this client yet.' : 'No journal entries match this status.'}
        </p>
      ) : (
        <div className="mt-5 space-y-3">
          {visibleEntries.map((entry) => {
            const lines = entry.journal_lines || [];
            const totalDebit = lines.reduce((sum, line) => sum + Number(line.debit || 0), 0);
            const totalCredit = lines.reduce((sum, line) => sum + Number(line.credit || 0), 0);

            return (
              <details key={entry.id} className="group rounded-xl border border-slate-800 bg-slate-950/50">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <p className="font-medium text-slate-100">{entry.memo || 'Journal entry'}</p>
                    <p className="mt-1 text-xs text-slate-500">
                      {entry.entry_date} · {entry.reversal_of_journal_entry_id ? 'Reversal entry' : 'Original entry'}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="rounded-full border border-slate-700 px-2.5 py-1 text-xs font-semibold capitalize text-slate-300">{entry.status}</span>
                    <p className="mt-2 text-xs text-slate-500">{money(totalDebit)}</p>
                  </div>
                </summary>

                <div className="border-t border-slate-800 px-4 py-3">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-left text-sm">
                      <thead className="text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="pb-2 font-semibold">Ledger account</th>
                          <th className="pb-2 font-semibold">Description</th>
                          <th className="pb-2 text-right font-semibold">Debit</th>
                          <th className="pb-2 text-right font-semibold">Credit</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {lines.map((line) => (
                          <tr key={line.id}>
                            <td className="py-2 text-slate-200">
                              {line.categories?.coa_code ? `${line.categories.coa_code} · ` : ''}{line.categories?.name || 'Ledger account'}
                            </td>
                            <td className="py-2 text-slate-400">{line.description || '—'}</td>
                            <td className="py-2 text-right text-slate-300">{Number(line.debit) > 0 ? money(Number(line.debit)) : '—'}</td>
                            <td className="py-2 text-right text-slate-300">{Number(line.credit) > 0 ? money(Number(line.credit)) : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot className="border-t border-slate-700 font-semibold text-slate-200">
                        <tr>
                          <td className="pt-2" colSpan={2}>Totals</td>
                          <td className="pt-2 text-right">{money(totalDebit)}</td>
                          <td className="pt-2 text-right">{money(totalCredit)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </details>
            );
          })}
        </div>
      )}

      <p className="mt-4 text-xs text-slate-500">
        Showing the 50 most recent journal entries. This view does not post, reverse, or modify the ledger.
      </p>
    </section>
  );
}
