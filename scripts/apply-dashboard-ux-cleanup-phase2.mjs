import fs from 'node:fs';

const path = 'app/dashboard/page.tsx';
let source = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const original = source;

function replaceOnce(label, from, to) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: expected exactly one match, found ${count}. Nothing was written.`);
  }
  source = source.replace(from, to);
}

replaceOnce(
  'visible transaction derivation',
  `  const spendingTransactions = useMemo(() => {`,
  `  const dashboardTransactions = filteredTransactions.slice(0, 12);\n\n  const spendingTransactions = useMemo(() => {`,
);

replaceOnce(
  'transaction layout',
  `        <section className="grid gap-6 xl:grid-cols-[1fr_360px]">`,
  `        <section className="space-y-6">`,
);

replaceOnce(
  'transaction table mapping',
  `                    filteredTransactions.map((transaction) => {`,
  `                    dashboardTransactions.map((transaction) => {`,
);

replaceOnce(
  'transaction count description',
  `                    : \`${'${filteredTransactions.length}'} transaction${'${'}\n                        filteredTransactions.length === 1\n                          ? ''\n                          : 's'\n                      } shown\`}`,
  `                    : filteredTransactions.length > dashboardTransactions.length\n                      ? \`Showing ${'${dashboardTransactions.length}'} of ${'${filteredTransactions.length}'} transactions\`\n                      : \`${'${filteredTransactions.length}'} transaction${'${'}\n                          filteredTransactions.length === 1 ? '' : 's'\n                        } shown\`}`,
);

replaceOnce(
  'insights layout',
  `          <div className="space-y-6">\n            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">`,
  `          <div className="grid gap-6 lg:grid-cols-2">\n            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">`,
);

replaceOnce(
  'merchant summary limit',
  `                  merchantSummary.slice(0, 8).map((merchant) => (`,
  `                  merchantSummary.slice(0, 6).map((merchant) => (`,
);

replaceOnce(
  'category summary limit',
  `                  categorySummary.map((item) => (`,
  `                  categorySummary.slice(0, 6).map((item) => (`,
);

if (source === original) {
  throw new Error('No dashboard phase 2 cleanup changes were produced.');
}

fs.writeFileSync(path, source, 'utf8');
console.log('Dashboard UX cleanup phase 2 patch applied successfully.');
