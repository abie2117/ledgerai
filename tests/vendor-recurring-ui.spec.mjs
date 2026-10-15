import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
let server, url;
test.beforeAll(async () => {
  const { outputFiles: [bundle] } = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Panel from './components/VendorRecurringPanel';
      createRoot(document.getElementById('root')).render(<Panel clientId="client" canManage={!location.search.includes('viewer')}/>);`, resolveDir: process.cwd(), loader: 'tsx' },
    plugins: [{ name: 'synthetic-supabase', setup(b) {
      b.onResolve({ filter: /^@\/lib\/supabase-browser$/ }, () => ({ path: 'fixture', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        export const supabase={from(table){const q={select(){return q},eq(){return q},neq(){return q},order(){return fetch('/fixture?table='+table).then(r=>r.json())}};return q},
        rpc(name,args){return fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args})}).then(r=>r.json()).then(r=>({error:r.error?new Error(r.error):null}))}};
      `, loader: 'js' }));
    } }],
    bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' },
  });
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(bundle.contents); }
    else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });

async function setup(page, { error = '', viewer = false } = {}) {
  const source = { client_id: 'client', status: 'active', financial_source_status: 'active' };
  const base = { merchant_pattern: 'fun', cadence: 'monthly', expected_amount: '89.40', amount_tolerance: 0,
    occurrence_count: 3, first_occurrence_date: '2026-07-09', last_occurrence_date: '2026-09-07', confidence_score: 0.7, status: 'detected' };
  const candidates = [
    { ...base, id: 'canonical', accounts: { name: 'Plaid Checking', mask: '0000', plaid_items: source } },
    { ...base, id: 'historical', accounts: { name: 'Plaid Checking', mask: '0000', plaid_items: { ...source, financial_source_status: 'superseded' } } },
    { ...base, id: 'unknown', accounts: null },
    { ...base, id: 'foreign', accounts: { plaid_items: { ...source, client_id: 'other-client' } } },
  ];
  const requests = [];
  await page.route('**/fixture?*', route => route.fulfill({ json: { data: route.request().url().includes('table=vendors') ? [] : candidates, error: null } }));
  await page.route('**/rpc', route => {
    const request = route.request().postDataJSON(); requests.push(request);
    if (!error && request.name === 'review_recurring_transaction_candidate') candidates[0].status = 'confirmed';
    return route.fulfill({ json: { error: error || null } });
  });
  await page.goto(url + (viewer ? '?viewer' : ''));
  await expect(page.getByText('1 to review', { exact: true })).toBeVisible();
  return requests;
}

test('only authoritative evidence has actions; historical and unknown sources stay read-only', async ({ page }) => {
  await setup(page);
  await page.locator('summary').click();
  await expect(page.getByText('Historical source evidence · 3 preserved candidates')).toBeVisible();
  await expect(page.getByText(/Financial source: superseded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm evidence', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Dismiss', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Link vendor', exact: true })).toHaveCount(1);
  await expect(page.locator('details button')).toHaveCount(0);
});
test('confirmation targets canonical candidate and reloads active counts', async ({ page }) => {
  const requests = await setup(page);
  await page.getByRole('button', { name: 'Confirm evidence' }).click();
  await expect(page.getByText('Recurring evidence confirmed.', { exact: true })).toBeVisible();
  await expect(page.getByText('1 confirmed', { exact: true })).toBeVisible();
  expect(requests).toEqual([{ name: 'review_recurring_transaction_candidate', args: { p_candidate_id: 'canonical', p_client_id: 'client', p_action: 'confirm' } }]);
  await expect(page.getByText('Historical source evidence · 3 preserved candidates')).toBeVisible();
});
test('source rejection remains visible without a success message', async ({ page }) => {
  await setup(page, { error: 'Recurring evidence requires an active source.' });
  await page.getByRole('button', { name: 'Confirm evidence' }).click();
  await expect(page.getByText('Recurring evidence requires an active source.', { exact: true })).toBeVisible();
  await expect(page.getByText('Recurring evidence confirmed.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('1 to review', { exact: true })).toBeVisible();
});
test('viewer can inspect preserved evidence but has no mutation actions', async ({ page }) => {
  const requests = await setup(page, { viewer: true });
  await page.locator('summary').click();
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(requests).toHaveLength(0);
});
