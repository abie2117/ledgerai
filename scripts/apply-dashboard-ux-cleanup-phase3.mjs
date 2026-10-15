import fs from 'node:fs';

const path = 'app/dashboard/page.tsx';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Nothing was written.`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  'pagination state',
  "  const [reviewFilter, setReviewFilter] = useState('Needs Review');\n",
  "  const [reviewFilter, setReviewFilter] = useState('Needs Review');\n  const [transactionPage, setTransactionPage] = useState(1);\n",
);

replaceOnce(
  'dashboard transaction pagination',
  "  const dashboardTransactions = filteredTransactions.slice(0, 12);\n",
  `  const transactionsPerPage = 10;\n  const transactionPageCount = Math.max(\n    1,\n    Math.ceil(filteredTransactions.length / transactionsPerPage),\n  );\n  const safeTransactionPage = Math.min(transactionPage, transactionPageCount);\n  const transactionPageStart = (safeTransactionPage - 1) * transactionsPerPage;\n  const dashboardTransactions = filteredTransactions.slice(\n    transactionPageStart,\n    transactionPageStart + transactionsPerPage,\n  );\n\n  useEffect(() => {\n    setTransactionPage(1);\n  }, [\n    selectedClientId,\n    searchTerm,\n    categoryFilter,\n    accountFilter,\n    reviewFilter,\n    startDate,\n    endDate,\n  ]);\n`,
);

replaceOnce(
  'compact assistant card',
  '<section id="assistant" className="scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">',
  '<section id="assistant" className="scroll-mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl">',
);

replaceOnce(
  'assistant heading spacing',
  '<div className="mb-4">\n            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-400">LedgerAI intelligence</p>',
  '<div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">\n            <div>\n            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-400">LedgerAI intelligence</p>',
);

replaceOnce(
  'assistant intro close',
  `            <p className="mt-1 text-sm text-slate-400">\n              Ask a question about your transaction history and spending.\n            </p>\n          </div>\n\n          <div className="flex flex-col gap-3 sm:flex-row">`,
  `            <p className="mt-1 text-sm text-slate-400">\n              Ask a question about your transaction history and spending.\n            </p>\n            </div>\n            <span className="hidden text-xs text-slate-500 sm:block">Financial copilot</span>\n          </div>\n\n          <div className="flex flex-col gap-3 sm:flex-row">`,
);

replaceOnce(
  'assistant suggestions spacing',
  '<div className="mt-4 flex flex-wrap gap-2">',
  '<div className="mt-3 flex flex-wrap gap-2">',
);

replaceOnce(
  'filter layout',
  '<div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">',
  '<div className="grid gap-4 xl:grid-cols-[minmax(280px,1.25fr)_2fr] xl:items-end">',
);

replaceOnce(
  'filter controls layout',
  '<div className="grid gap-3 sm:grid-cols-2 xl:flex xl:items-end">',
  '<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 xl:items-end">',
);

replaceOnce(
  'transaction count copy',
  `                    : filteredTransactions.length > dashboardTransactions.length\n                      ? \`Showing \${dashboardTransactions.length} of \${filteredTransactions.length} transactions\`\n                      : \`\${filteredTransactions.length} transaction\${\n                          filteredTransactions.length === 1 ? '' : 's'\n                        } shown\`}`,
  `                    : filteredTransactions.length > 0\n                      ? \`Showing \${transactionPageStart + 1}–\${Math.min(\n                          transactionPageStart + dashboardTransactions.length,\n                          filteredTransactions.length,\n                        )} of \${filteredTransactions.length} transactions\`\n                      : '0 transactions shown'}`,
);

replaceOnce(
  'pagination footer',
  `              </table>\n            </div>\n          </div>\n\n          <div className="grid gap-6 lg:grid-cols-2">`,
  `              </table>\n            </div>\n\n            {filteredTransactions.length > transactionsPerPage && (\n              <div className="flex flex-col gap-3 border-t border-slate-800 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">\n                <p className="text-xs text-slate-500">\n                  Page {safeTransactionPage} of {transactionPageCount}\n                </p>\n                <div className="flex gap-2">\n                  <button\n                    type="button"\n                    onClick={() => setTransactionPage((page) => Math.max(1, page - 1))}\n                    disabled={safeTransactionPage === 1}\n                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-cyan-400 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"\n                  >\n                    Previous\n                  </button>\n                  <button\n                    type="button"\n                    onClick={() =>\n                      setTransactionPage((page) => Math.min(transactionPageCount, page + 1))\n                    }\n                    disabled={safeTransactionPage === transactionPageCount}\n                    className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-cyan-400 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"\n                  >\n                    Next\n                  </button>\n                </div>\n              </div>\n            )}\n          </div>\n\n          <div className="grid items-start gap-6 lg:grid-cols-2">`,
);

replaceOnce(
  'merchant summary density',
  'merchantSummary.slice(0, 6).map((merchant) => (',
  'merchantSummary.slice(0, 5).map((merchant) => (',
);

replaceOnce(
  'category summary density',
  'categorySummary.slice(0, 6).map((item) => (',
  'categorySummary.slice(0, 5).map((item) => (',
);

fs.writeFileSync(path, source, 'utf8');
console.log('Dashboard UX cleanup phase 3 patch applied successfully.');
