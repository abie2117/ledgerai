'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase-browser';

interface Vendor {
  id: string;
  display_name: string;
  status: string;
}

interface RecurringCandidate {
  id: string;
  vendor_id?: string | null;
  merchant_pattern: string;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'annual';
  expected_amount?: number | string | null;
  amount_tolerance: number | string;
  occurrence_count: number;
  first_occurrence_date: string;
  last_occurrence_date: string;
  next_expected_date?: string | null;
  confidence_score: number | string;
  status: 'detected' | 'confirmed' | 'dismissed' | string;
  accounts?: { name?: string | null; mask?: string | null } | null;
}

interface Props { clientId: string; canManage: boolean; }

function money(value: number | string | null | undefined) {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value));
}

function titleCase(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function VendorRecurringPanel({ clientId, canManage }: Props) {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [candidates, setCandidates] = useState<RecurringCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!clientId) return;
    setLoading(true);
    setError('');

    try {
      const [{ data: vendorData, error: vendorError }, { data: candidateData, error: candidateError }] = await Promise.all([
        supabase.from('vendors').select('id, display_name, status').eq('client_id', clientId).order('display_name'),
        supabase
          .from('recurring_transaction_candidates')
          .select('id, vendor_id, merchant_pattern, cadence, expected_amount, amount_tolerance, occurrence_count, first_occurrence_date, last_occurrence_date, next_expected_date, confidence_score, status, accounts(name, mask)')
          .eq('client_id', clientId)
          .neq('status', 'dismissed')
          .order('next_expected_date', { ascending: true, nullsFirst: false }),
      ]);

      if (vendorError) throw vendorError;
      if (candidateError) throw candidateError;
      setVendors((vendorData || []) as Vendor[]);
      setCandidates((candidateData || []) as RecurringCandidate[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load vendor and recurring activity.');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMessage('');
      setError('');
      void load();
    });
    return () => { cancelled = true; };
  }, [load]);

  const vendorById = useMemo(() => new Map(vendors.map((vendor) => [vendor.id, vendor])), [vendors]);
  const detectedCount = candidates.filter((candidate) => candidate.status === 'detected').length;
  const confirmedCount = candidates.filter((candidate) => candidate.status === 'confirmed').length;

  async function review(candidate: RecurringCandidate, action: 'confirm' | 'dismiss') {
    if (!canManage || actingId || candidate.status !== 'detected') return;

    try {
      setActingId(candidate.id);
      setError('');
      setMessage('');
      const { error: rpcError } = await supabase.rpc('review_recurring_transaction_candidate', {
        p_candidate_id: candidate.id,
        p_client_id: clientId,
        p_action: action,
      });
      if (rpcError) throw rpcError;
      setMessage(action === 'confirm' ? 'Recurring evidence confirmed.' : 'Recurring evidence dismissed.');
      await load();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Unable to review recurring evidence.');
    } finally {
      setActingId(null);
    }
  }

  async function linkVendor(candidate: RecurringCandidate) {
    if (!canManage || actingId) return;
    const displayName = (vendorNames[candidate.id] || titleCase(candidate.merchant_pattern)).trim();
    if (!displayName) return;

    try {
      setActingId(candidate.id);
      setError('');
      setMessage('');
      const { error: rpcError } = await supabase.rpc('create_or_link_vendor', {
        p_client_id: clientId,
        p_display_name: displayName,
        p_merchant_pattern: candidate.merchant_pattern,
      });
      if (rpcError) throw rpcError;
      setMessage('Vendor identity linked to the recurring evidence.');
      setVendorNames((current) => ({ ...current, [candidate.id]: '' }));
      await load();
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Unable to link vendor identity.');
    } finally {
      setActingId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Vendors & Recurring Activity</h2>
          <p className="mt-1 text-sm text-slate-400">
            Review recurring transaction evidence and connect normalized merchant patterns to vendor identities.
          </p>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{detectedCount} to review</span>
          <span className="rounded-full border border-slate-700 px-3 py-1 text-slate-300">{confirmedCount} confirmed</span>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        Recurring detection is evidence only. Confirming a pattern does not create a bill, payment, journal entry, transaction approval, or financial report entry.
      </p>

      {error && <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">{error}</div>}
      {message && <div className="mt-4 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">{message}</div>}

      {loading ? (
        <p className="mt-5 text-sm text-slate-500">Loading recurring activity…</p>
      ) : candidates.length === 0 ? (
        <p className="mt-5 text-sm text-slate-500">No active recurring transaction evidence has been detected for this client yet.</p>
      ) : (
        <div className="mt-5 space-y-3">
          {candidates.map((candidate) => {
            const vendor = candidate.vendor_id ? vendorById.get(candidate.vendor_id) : null;
            const confidence = Math.round(Number(candidate.confidence_score) * 100);
            const account = candidate.accounts?.name
              ? `${candidate.accounts.name}${candidate.accounts.mask ? ` ••••${candidate.accounts.mask}` : ''}`
              : 'Connected account';

            return (
              <div key={candidate.id} className="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(220px,0.7fr)]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-slate-100">{vendor?.display_name || titleCase(candidate.merchant_pattern)}</p>
                      <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[11px] font-semibold capitalize text-slate-400">{candidate.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{account} · pattern: {candidate.merchant_pattern}</p>
                    <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-4">
                      <div><span className="text-slate-500">Cadence</span><p className="font-medium capitalize text-slate-200">{candidate.cadence}</p></div>
                      <div><span className="text-slate-500">Typical amount</span><p className="font-medium text-slate-200">{money(candidate.expected_amount)}</p></div>
                      <div><span className="text-slate-500">Occurrences</span><p className="font-medium text-slate-200">{candidate.occurrence_count}</p></div>
                      <div><span className="text-slate-500">Evidence confidence</span><p className="font-medium text-slate-200">{confidence}%</p></div>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                      Observed {candidate.first_occurrence_date} → {candidate.last_occurrence_date}
                      {candidate.next_expected_date ? ` · next expected around ${candidate.next_expected_date}` : ''}
                      {Number(candidate.amount_tolerance) > 0 ? ` · observed amount variation ±${money(candidate.amount_tolerance)}` : ''}
                    </p>
                  </div>

                  <div className="flex flex-col justify-center gap-2">
                    {!vendor && canManage && (
                      <div className="flex gap-2">
                        <input
                          value={vendorNames[candidate.id] ?? ''}
                          onChange={(event) => setVendorNames((current) => ({ ...current, [candidate.id]: event.target.value }))}
                          placeholder={titleCase(candidate.merchant_pattern)}
                          className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200"
                        />
                        <button type="button" disabled={!!actingId} onClick={() => void linkVendor(candidate)} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-50">
                          Link vendor
                        </button>
                      </div>
                    )}
                    {vendor && <p className="text-xs text-emerald-300">Linked vendor: {vendor.display_name}</p>}
                    {candidate.status === 'detected' && canManage && (
                      <div className="flex gap-2">
                        <button type="button" disabled={!!actingId} onClick={() => void review(candidate, 'confirm')} className="flex-1 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-500 disabled:opacity-50">Confirm evidence</button>
                        <button type="button" disabled={!!actingId} onClick={() => void review(candidate, 'dismiss')} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-400 hover:border-red-700 hover:text-red-300 disabled:opacity-50">Dismiss</button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!canManage && <p className="mt-4 text-xs text-amber-300">Owner, admin, or bookkeeper access is required to link vendors or review recurring evidence.</p>}
    </section>
  );
}
