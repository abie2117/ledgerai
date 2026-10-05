'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import AccountingSetupPanel from '@/components/AccountingSetupPanel';
import ReconciliationPanel from '@/components/ReconciliationPanel';
import JournalActivityPanel from '@/components/JournalActivityPanel';
import VendorRecurringPanel from '@/components/VendorRecurringPanel';
import { supabase } from '@/lib/supabase-browser';

const ACCOUNTING_ROLES = new Set(['owner', 'admin', 'bookkeeper']);

function AccountingWorkspaceContent() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const [canManage, setCanManage] = useState(false);
  const [accessLoading, setAccessLoading] = useState(Boolean(clientId));
  const dashboardHref = clientId ? `/dashboard?clientId=${encodeURIComponent(clientId)}` : '/dashboard';
  const banksHref = clientId ? `/dashboard/banks?clientId=${encodeURIComponent(clientId)}` : '/dashboard/banks';

  useEffect(() => {
    let cancelled = false;

    async function loadAccess() {
      if (!clientId) {
        setCanManage(false);
        setAccessLoading(false);
        return;
      }

      setAccessLoading(true);
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          if (!cancelled) setCanManage(false);
          return;
        }

        const { data: client } = await supabase
          .from('clients')
          .select('firm_id')
          .eq('id', clientId)
          .maybeSingle();

        if (!client?.firm_id) {
          if (!cancelled) setCanManage(false);
          return;
        }

        const { data: membership } = await supabase
          .from('firm_users')
          .select('role')
          .eq('firm_id', client.firm_id)
          .eq('user_id', user.id)
          .maybeSingle();

        if (!cancelled) setCanManage(ACCOUNTING_ROLES.has(membership?.role ?? ''));
      } finally {
        if (!cancelled) setAccessLoading(false);
      }
    }

    void loadAccess();
    return () => { cancelled = true; };
  }, [clientId]);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
          <div className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-white sm:text-3xl">
                  Ledger<span className="text-cyan-400">AI</span>
                </h1>
                <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
                  Enterprise
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-400">Accounting workspace</p>
            </div>
            <a href={dashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-500/50 hover:text-white">
              Back to overview
            </a>
          </div>

          <nav className="flex flex-wrap items-center gap-1 border-t border-slate-800 bg-slate-950/35 px-5 py-2 sm:px-6" aria-label="LedgerAI workspace">
            <a href={dashboardHref} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Overview</a>
            <a href={`${dashboardHref}#transactions`} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Transactions</a>
            <a href={banksHref} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Banking</a>
            <span className="rounded-lg bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-300">Accounting</span>
            <span className="cursor-not-allowed rounded-lg px-3 py-2 text-sm font-medium text-slate-600" title="Coming later in the LedgerAI roadmap">Reports</span>
          </nav>
        </header>

        {!clientId ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-white">Select a client first</h2>
            <p className="mt-2 text-sm text-slate-400">Choose the active client on the overview before opening its accounting workspace.</p>
            <a href="/dashboard" className="mt-4 inline-flex rounded-lg border border-cyan-500/30 px-4 py-2 text-sm font-semibold text-cyan-300 transition hover:border-cyan-400 hover:text-white">Go to overview</a>
          </section>
        ) : accessLoading ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-sm text-slate-400">Loading accounting workspace…</section>
        ) : (
          <>
            <AccountingSetupPanel clientId={clientId} canManage={canManage} />
            <JournalActivityPanel clientId={clientId} />
            <VendorRecurringPanel clientId={clientId} canManage={canManage} />
            <ReconciliationPanel clientId={clientId} canManage={canManage} />
          </>
        )}
      </div>
    </main>
  );
}

export default function AccountingWorkspacePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-950" />}>
      <AccountingWorkspaceContent />
    </Suspense>
  );
}
