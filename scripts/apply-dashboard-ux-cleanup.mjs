import fs from 'node:fs';

const path = 'app/dashboard/page.tsx';
let source = fs.readFileSync(path, 'utf8');
const original = source;

function replaceOnce(label, from, to) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Nothing was written.`);
  }
  source = source.replace(from, to);
}

replaceOnce(
  'workspace navigation insertion point',
  `          <div className="grid gap-4 px-5 py-5 sm:px-6 xl:grid-cols-[minmax(260px,1.2fr)_minmax(190px,0.7fr)_auto] xl:items-end">`,
  `          <nav className="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-950/35 px-5 py-2 sm:px-6" aria-label="LedgerAI workspace">
            <a href="#overview" className="rounded-lg bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-300">Overview</a>
            <a href="#transactions" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Transactions</a>
            <a href="#transactions" onClick={() => setReviewFilter('Needs Review')} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Review</a>
            <a href={selectedClientId ? \`/dashboard/banks?clientId=\${selectedClientId}\` : '/dashboard/banks'} className="rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-white">Banks</a>
            <span className="cursor-not-allowed rounded-lg px-3 py-2 text-sm font-medium text-slate-600" title="Coming later in the LedgerAI roadmap">Reports</span>
          </nav>

          <div className="grid gap-4 px-5 py-4 sm:px-6 xl:grid-cols-[minmax(260px,1.2fr)_minmax(190px,0.7fr)_auto] xl:items-end">`,
);

replaceOnce(
  'overview section',
  `        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">`,
  `        <section id="overview" className="scroll-mt-6 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-400">Financial overview</p>
              <h2 className="mt-1 text-xl font-bold text-white">{selectedClient?.name || 'Client'} at a glance</h2>
              <p className="mt-1 text-sm text-slate-400">Key activity and items that need your attention.</p>
            </div>
            <a href="#transactions" onClick={() => setReviewFilter('Needs Review')} className="text-sm font-semibold text-cyan-400 transition hover:text-cyan-300">
              Review transactions →
            </a>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5">
              <p className="text-sm font-semibold text-amber-200">Needs your attention</p>
              <div className="mt-2 flex items-end gap-3">
                <span className="text-3xl font-bold text-white">{transactions.filter((transaction) => transaction.status === 'pending_review').length}</span>
                <span className="pb-1 text-sm text-slate-400">transactions awaiting review</span>
              </div>
              <p className="mt-2 text-xs text-slate-500">Approve or correct transactions before finalizing the books.</p>
            </div>
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <p className="text-sm font-semibold text-white">Bank workspace</p>
              <p className="mt-2 text-sm leading-6 text-slate-400">Connection management now has its own focused workspace.</p>
              <a href={selectedClientId ? \`/dashboard/banks?clientId=\${selectedClientId}\` : '/dashboard/banks'} className="mt-3 inline-flex text-sm font-semibold text-cyan-400 transition hover:text-cyan-300">Manage banks →</a>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">`,
);

replaceOnce(
  'assistant section transition',
  `        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-white">
              🔍 Ask anything about your finances`,
  `          </div>
        </section>

        <section id="assistant" className="scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div className="mb-4">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-400">LedgerAI intelligence</p>
            <h2 className="mt-1 text-lg font-semibold text-white">
              Ask anything about your finances`,
);

replaceOnce(
  'transaction filters id',
  `        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">`,
  `        <section id="transactions" className="scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-400">Transaction workspace</p>
              <h2 className="mt-1 text-xl font-bold text-white">Review and organize transactions</h2>
            </div>
            <span className="text-sm text-slate-500">{filteredTransactions.length} shown</span>
          </div>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">`,
);

replaceOnce(
  'connected banks panel wrapper',
  `        {selectedClientId && (
          <ConnectedBanksPanel
            clientId={selectedClientId}
            refreshKey={connectionsRefreshKey}
            onTransactionsReload={() =>
              setTransactionsRefreshKey((currentKey) => currentKey + 1)
            }
          />
        )}`,
  `        {selectedClientId && (
          <details className="group rounded-2xl border border-slate-800 bg-slate-900/70">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-slate-200 sm:px-6">
              <span>Bank connections</span>
              <span className="text-xs font-medium text-slate-500 group-open:hidden">Show details</span>
              <span className="hidden text-xs font-medium text-slate-500 group-open:inline">Hide details</span>
            </summary>
            <div className="border-t border-slate-800 p-3">
              <ConnectedBanksPanel
                clientId={selectedClientId}
                refreshKey={connectionsRefreshKey}
                onTransactionsReload={() =>
                  setTransactionsRefreshKey((currentKey) => currentKey + 1)
                }
              />
            </div>
          </details>
        )}`,
);

if (source === original) {
  throw new Error('No dashboard changes were produced.');
}

fs.writeFileSync(path, source, 'utf8');
console.log('Dashboard UX cleanup patch applied successfully.');
