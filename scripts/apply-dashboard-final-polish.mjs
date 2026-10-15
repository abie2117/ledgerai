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

// Match the dashboard wordmark to the login-page treatment: white Ledger + violet AI.
replaceOnce(
  'dashboard wordmark',
  '<h1 className="text-2xl font-extrabold tracking-[-0.03em] text-white sm:text-3xl">\n                    Ledger<span className="text-cyan-400">AI</span>\n                  </h1>',
  '<h1 className="text-2xl font-extrabold tracking-[-0.03em] text-white sm:text-3xl">\n                    Ledger<span className="text-violet-400">AI</span>\n                  </h1>',
);

// Give the filter row enough room for readable date controls while keeping it responsive.
replaceOnce(
  'transaction filter grid',
  'className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 xl:items-end"',
  'className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-[minmax(180px,1.1fr)_minmax(180px,1.1fr)_minmax(160px,1fr)_minmax(155px,0.9fr)_minmax(155px,0.9fr)_auto] xl:items-end"',
);

replaceOnce(
  'start date width',
  'id="start-date"\n                  type="date"',
  'id="start-date"\n                  type="date"',
);

// Add a stable row-number column. Numbering continues across pagination.
replaceOnce(
  'transaction table date header',
  '<tr>\n                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      Date\n                    </th>',
  '<tr>\n                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      #\n                    </th>\n\n                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      Date\n                    </th>',
);

source = source.replaceAll('colSpan={8}', 'colSpan={9}');

replaceOnce(
  'transaction map index',
  'dashboardTransactions.map((transaction) => {',
  'dashboardTransactions.map((transaction, transactionIndex) => {',
);

replaceOnce(
  'transaction row first cell',
  '<tr\n                          key={transaction.id}\n                          className="transition hover:bg-slate-800/40"\n                        >\n                          <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-300">\n                            {formatDate(getTransactionDate(transaction))}\n                          </td>',
  '<tr\n                          key={transaction.id}\n                          className="transition hover:bg-slate-800/40"\n                        >\n                          <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-slate-500">\n                            {transactionPageStart + transactionIndex + 1}\n                          </td>\n\n                          <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-300">\n                            {formatDate(getTransactionDate(transaction))}\n                          </td>',
);

if (source === original) {
  throw new Error('No changes were produced. Nothing was written.');
}

fs.writeFileSync(file, source, 'utf8');
console.log('Dashboard final polish patch applied successfully.');
