'use client';

import { FormEvent, useCallback, useEffect, useState } from 'react';

interface Account {
  id: string; name: string; coa_code: string | null; account_type: string | null;
  normal_balance: string | null; is_active: boolean; is_posting_account: boolean;
}
const types = ['asset', 'liability', 'equity', 'revenue', 'expense'];
const inputClass = 'w-full rounded-lg border border-slate-700 bg-slate-950 p-3 text-slate-100 disabled:opacity-50';

export default function ChartOfAccountsPanel({ clientId, canManage }: { clientId: string; canManage: boolean }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState('expense');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/chart-of-accounts?clientId=${encodeURIComponent(clientId)}`, { signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load Chart of Accounts.');
    if (signal?.aborted) return;
    setAccounts(data.accounts || []);
    setAllowed(Boolean(data.canManage));
  }, [clientId]);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoading(true); setError(''); setMessage(''); setAllowed(false);
      setName(''); setCode(''); setType('expense');
      void load(controller.signal).catch(e => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : 'Unable to load accounts.');
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    });
    const refresh = () => { void load(controller.signal).catch(() => {}); };
    window.addEventListener('ledgerai:accounting-setup-changed', refresh);
    return () => { controller.abort(); window.removeEventListener('ledgerai:accounting-setup-changed', refresh); };
  }, [load]);
  const editable = canManage && allowed && !loading && !saving;
  const balance = ['asset', 'expense'].includes(type) ? 'Debit' : 'Credit';
  async function create(event: FormEvent) {
    event.preventDefault();
    if (!editable) return;
    setSaving(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/chart-of-accounts', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId, name, coaCode: code, accountType: type }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to create ledger account.');
      setMessage(`Created ${code} · ${name}. Select it when categorizing a transaction.`);
      setName(''); setCode('');
      window.dispatchEvent(new CustomEvent('ledgerai:accounting-setup-changed', { detail: { clientId } }));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to create ledger account.'); }
    finally { setSaving(false); }
  }
  return <section id="chart-of-accounts" className="rounded-2xl border border-slate-800 bg-slate-900 p-6">
    <h2 className="text-xl font-semibold text-white">Chart of Accounts</h2>
    <p className="mt-2 text-sm text-slate-400">Create ledger accounts for this client’s books. Shared categorization labels are unchanged.</p>
    {error && <p role="alert" className="mt-4 text-red-300">{error}</p>}
    {message && <p role="status" className="mt-4 text-emerald-300">{message}</p>}
    <form onSubmit={create} className="mt-5 grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Account name<input className={inputClass} value={name} onChange={e => setName(e.target.value)} required maxLength={120} disabled={!editable} /></label>
      <label className="text-sm">Account code<input className={inputClass} value={code} onChange={e => setCode(e.target.value)} required maxLength={30} disabled={!editable} /></label>
      <label className="text-sm">Account type<select className={inputClass} value={type} onChange={e => setType(e.target.value)} disabled={!editable}>{types.map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}</select></label>
      <div className="text-sm text-slate-400"><p>Normal balance: {balance}</p><p className="mt-2">New accounts are active and accept journal postings.</p></div>
      <button disabled={!editable} className="rounded-lg border border-cyan-500/40 px-4 py-3 text-sm font-semibold text-cyan-300 disabled:opacity-50">{saving ? 'Creating…' : 'Create ledger account'}</button>
    </form>
    {!loading && !(canManage && allowed) && <p className="mt-3 text-sm text-amber-300">Owner, admin, or bookkeeper access is required to create accounts.</p>}
    {loading ? <p className="mt-5 text-slate-400">Loading accounts…</p> : <div className="mt-5 overflow-x-auto">
      <table className="w-full text-left text-sm"><thead><tr className="text-slate-400"><th className="p-2">Code</th><th className="p-2">Account</th><th className="p-2">Type</th><th className="p-2">Normal balance</th><th className="p-2">Status</th></tr></thead>
        <tbody>{accounts.map(a => <tr key={a.id} className="border-t border-slate-800"><td className="p-2">{a.coa_code || '—'}</td><td className="p-2">{a.name}</td><td className="p-2">{a.account_type || 'Unclassified'}</td><td className="p-2">{a.normal_balance || '—'}</td><td className="p-2">{!a.is_active ? 'Inactive' : !a.account_type || !a.normal_balance ? 'Needs classification' : a.is_posting_account ? 'Active posting account' : 'Header account'}</td></tr>)}</tbody>
      </table>{accounts.length === 0 && <p className="mt-3 text-slate-400">No client-specific accounts yet.</p>}
    </div>}
  </section>;
}
