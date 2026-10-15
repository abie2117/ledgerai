import fs from 'node:fs';

const file = 'app/dashboard/page.tsx';
let source = fs.readFileSync(file, 'utf8');
const original = source;

function replaceOnce(label, search, replacement) {
  const count = source.split(search).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Nothing was written.`);
  }
  source = source.replace(search, replacement);
}

// Match the login-page wordmark exactly: white Ledger + #38bdf8 AI (Tailwind sky-400).
replaceOnce(
  'dashboard wordmark',
  'Ledger<span className="text-violet-400">AI</span>',
  'Ledger<span className="text-sky-400">AI</span>',
);

// Keep the page itself inside the viewport. Wide transaction tables may scroll inside their own card.
replaceOnce(
  'dashboard main overflow guard',
  '<main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">',
  '<main className="min-h-screen overflow-x-hidden bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">',
);

// Let the transaction search/filter workspace wrap before it can force page-level horizontal overflow.
replaceOnce(
  'transaction workspace outer grid',
  'className="grid gap-4 xl:grid-cols-[minmax(280px,1.25fr)_2fr] xl:items-end"',
  'className="grid min-w-0 gap-4 2xl:grid-cols-[minmax(260px,0.9fr)_minmax(0,2.1fr)] 2xl:items-end"',
);

replaceOnce(
  'transaction filter grid',
  'className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(180px,1.1fr)_minmax(180px,1.1fr)_minmax(160px,1fr)_minmax(155px,0.9fr)_minmax(155px,0.9fr)_auto] xl:items-end"',
  'className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_auto] 2xl:items-end"',
);

// Remove fixed minimum widths that can make the six-control row wider than its container.
source = source.replaceAll('w-full min-w-[180px] rounded-lg', 'w-full min-w-0 rounded-lg');
source = source.replaceAll('w-full min-w-[160px] rounded-lg', 'w-full min-w-0 rounded-lg');

if (source === original) {
  throw new Error('No changes were produced. Nothing was written.');
}

fs.writeFileSync(file, source, 'utf8');
console.log('Dashboard production-ready polish patch applied successfully.');
