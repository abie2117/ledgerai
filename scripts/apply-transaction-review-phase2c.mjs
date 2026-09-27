import fs from 'node:fs';

const path = 'app/dashboard/page.tsx';
const original = fs.readFileSync(path, 'utf8');
let content = original;

function replaceOnce(label, pattern, replacement) {
  const matches = content.match(pattern);
  if (!matches) throw new Error(`${label}: target not found`);
  content = content.replace(pattern, replacement);
}

replaceOnce(
  'transaction review fields',
  /  ai_category_id\?: string \| null;\r?\n/,
  "  ai_category_id?: string | null;\n  status?: 'pending_review' | 'confirmed' | string | null;\n  confidence_score?: number | null;\n",
);

replaceOnce(
  'review filter state',
  /  const \[accountFilter, setAccountFilter\] = useState\('All Accounts'\);\r?\n/,
  "  const [accountFilter, setAccountFilter] = useState('All Accounts');\n  const [reviewFilter, setReviewFilter] = useState('Needs Review');\n",
);

replaceOnce(
  'review filter predicate',
  /(      const matchesAccount =\r?\n        accountFilter === 'All Accounts' \|\|\r?\n        account === accountFilter;\r?\n)/,
  `$1\n      const matchesReview =\n        reviewFilter === 'All Transactions' ||\n        (reviewFilter === 'Needs Review' &&\n          transaction.status === 'pending_review') ||\n        (reviewFilter === 'Confirmed' &&\n          transaction.status === 'confirmed');\n`,
);

replaceOnce(
  'review filter return',
  /        matchesAccount &&\r?\n        matchesStartDate &&/,
  `        matchesAccount &&\n        matchesReview &&\n        matchesStartDate &&`,
);

replaceOnce(
  'review filter dependency',
  /    accountFilter,\r?\n    startDate,/,
  `    accountFilter,\n    reviewFilter,\n    startDate,`,
);

// Reset review status alongside the existing account filter in both client-change and clearFilters.
content = content.replace(
  /    setAccountFilter\('All Accounts'\);\r?\n/g,
  "    setAccountFilter('All Accounts');\n    setReviewFilter('Needs Review');\n",
);

replaceOnce(
  'category correction local confirmation',
  /                category: result\.category\.name,\r?\n                canonical_category:/,
  `                category: result.category.name,\n                status: 'confirmed',\n                canonical_category:`,
);

replaceOnce(
  'review filter control',
  /(              <div>\r?\n                <label\r?\n                  htmlFor="start-date")/,
  `              <div>\n                <label\n                  htmlFor="review-filter"\n                  className="mb-2 block text-sm font-medium text-slate-300"\n                >\n                  Review Status\n                </label>\n\n                <select\n                  id="review-filter"\n                  value={reviewFilter}\n                  onChange={(event) => setReviewFilter(event.target.value)}\n                  className="w-full min-w-[160px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"\n                >\n                  <option value="Needs Review">Needs Review</option>\n                  <option value="Confirmed">Confirmed</option>\n                  <option value="All Transactions">All Transactions</option>\n                </select>\n              </div>\n\n$1`,
);

replaceOnce(
  'approve handler',
  /  async function handleLocalCategorize\(\) \{/,
  `  async function handleApproveTransaction(transactionId: string) {\n    if (!selectedClientId) return;\n\n    try {\n      setSavingCategoryId(transactionId);\n      setErrorMessage('');\n      setSuccessMessage('');\n\n      const response = await fetch('/api/transactions/confirm', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json' },\n        body: JSON.stringify({\n          transactionId,\n          clientId: selectedClientId,\n        }),\n      });\n\n      const result = await response.json().catch(() => ({}));\n\n      if (!response.ok) {\n        throw new Error(result.error || 'Unable to approve transaction.');\n      }\n\n      setTransactions((currentTransactions) =>\n        currentTransactions.map((transaction) =>\n          transaction.id === transactionId\n            ? { ...transaction, status: 'confirmed' }\n            : transaction,\n        ),\n      );\n\n      setSuccessMessage('Transaction approved successfully.');\n    } catch (error: any) {\n      console.error('Error approving transaction:', error);\n      setErrorMessage(error?.message || 'Unable to approve transaction.');\n    } finally {\n      setSavingCategoryId(null);\n    }\n  }\n\n  async function handleLocalCategorize() {`,
);

replaceOnce(
  'confidence and status headers',
  /(                    <th className="whitespace-nowrap px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">\r?\n                      Amount\r?\n                    <\/th>)/,
  `                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      Confidence\n                    </th>\n\n                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      Status\n                    </th>\n\n                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">\n                      Review\n                    </th>\n\n$1`,
);

content = content.replace(/colSpan=\{5\}/g, 'colSpan={8}');

replaceOnce(
  'review row cells',
  /(                          <td className="whitespace-nowrap px-5 py-4 text-right text-sm font-semibold text-white">\r?\n                            \{formatCurrency\()/,
  `                          <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-300">\n                            {transaction.confidence_score == null\n                              ? '—'\n                              : \`${'${Math.round(Number(transaction.confidence_score) * 100)}'}%\`}\n                          </td>\n\n                          <td className="whitespace-nowrap px-5 py-4">\n                            <span\n                              className={\`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${'${'}\n                                transaction.status === 'confirmed'\n                                  ? 'bg-emerald-500/10 text-emerald-300'\n                                  : 'bg-amber-500/10 text-amber-300'\n                              }\`}\n                            >\n                              {transaction.status === 'confirmed'\n                                ? 'Confirmed'\n                                : 'Needs review'}\n                            </span>\n                          </td>\n\n                          <td className="whitespace-nowrap px-5 py-4">\n                            {transaction.status === 'confirmed' ? (\n                              <span className="text-xs font-medium text-emerald-300">\n                                Confirmed\n                              </span>\n                            ) : (\n                              <button\n                                type="button"\n                                onClick={() =>\n                                  handleApproveTransaction(transaction.id)\n                                }\n                                disabled={isSaving}\n                                className="rounded-lg border border-emerald-500/50 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-50"\n                              >\n                                {isSaving ? 'Approving...' : 'Approve'}\n                              </button>\n                            )}\n                          </td>\n\n$1`,
);

if (content === original) throw new Error('No changes produced');

// Atomic write: only reached after every required target matched.
const tempPath = `${path}.phase2c.tmp`;
fs.writeFileSync(tempPath, content, 'utf8');
fs.renameSync(tempPath, path);
console.log('Phase 2C transaction review workspace patch applied successfully.');
