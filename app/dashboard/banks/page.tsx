'use client';

import { useSearchParams } from 'next/navigation';
import ConnectedBanksPanel from '@/components/ConnectedBanksPanel';

export default function BankManagementPage() {
  const searchParams = useSearchParams();
  const clientId = searchParams.get('clientId') ?? '';
  const dashboardHref = clientId ? `/dashboard?clientId=${encodeURIComponent(clientId)}` : '/dashboard';

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2.5">
                <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-white sm:text-3xl">
                  Ledger<span className="text-cyan-400">AI</span>
                </h1>
                <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
                  Enterprise
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-400">Bank connections</p>
            </div>
            <a href={dashboardHref} className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 transition hover:border-cyan-500/50 hover:text-white">
              Back to dashboard
            </a>
          </div>
        </header>

        {!clientId ? (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-white">Select a client first</h2>
            <p className="mt-2 text-sm text-slate-400">Open the dashboard, select the client whose bank connections you want to manage, then choose Manage banks.</p>
            <a href="/dashboard" className="mt-4 inline-flex rounded-lg border border-cyan-500/30 px-4 py-2 text-sm font-semibold text-cyan-300 transition hover:border-cyan-400 hover:text-white">Go to dashboard</a>
          </section>
        ) : (
          <ConnectedBanksPanel clientId={clientId} refreshKey={0} onTransactionsReload={() => undefined} mode="management" />
        )}
      </div>
    </main>
  );
}
