import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
let server, url;
test.beforeAll(async () => {
  const { outputFiles: [bundle] } = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Panel from './components/ChartOfAccountsPanel';
      createRoot(document.getElementById('root')).render(<Panel clientId="client" canManage={true}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic', define: {'process.env.NODE_ENV':'"development"'},
  });
  server = createServer((req,res) => {
    if (req.url === '/bundle.js') { res.writeHead(200, {'Content-Type':'application/javascript'}); res.end(bundle.contents); }
    else { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function setup(page, { viewer = false, error = '' } = {}) {
  const posts = []; let created = false;
  await page.route('**/api/chart-of-accounts?*', route => route.fulfill({json:{canManage: !viewer,
    accounts: created ? [{id:'travel',name:'Travel',coa_code:'6110',account_type:'expense',normal_balance:'debit',is_active:true,is_posting_account:true}] : []}}));
  await page.route('**/api/chart-of-accounts', route => {
    posts.push(route.request().postDataJSON());
    if (error) return route.fulfill({status:409,json:{error}});
    created = true; return route.fulfill({json:{success:true,categoryId:'travel'}});
  });
  await page.goto(url);
  await expect(page.getByText('Loading accounts…')).toHaveCount(0);
  return posts;
}
test('create client expense and refresh its normal balance and status', async ({page}) => {
  const posts = await setup(page);
  await page.getByLabel('Account name').fill('Travel');
  await page.getByLabel('Account code').fill('6110');
  await expect(page.getByText('Normal balance: Debit', {exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create ledger account'}).click();
  await expect(page.getByRole('cell',{name:'Travel',exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Active posting account'})).toBeVisible();
  expect(posts).toEqual([{clientId:'client',name:'Travel',coaCode:'6110',accountType:'expense'}]);
});
test('server permissions disable creation even with stale manager prop', async ({page}) => {
  const posts = await setup(page,{viewer:true});
  await expect(page.getByRole('button',{name:'Create ledger account'})).toBeDisabled();
  await expect(page.getByLabel('Account name')).toBeDisabled();
  expect(posts).toHaveLength(0);
});
test('failure preserves form for correction and account type derives credit balance', async ({page}) => {
  await setup(page,{error:'This client already has an account with that code or name.'});
  await page.getByLabel('Account name').fill('Travel');
  await page.getByLabel('Account code').fill('6110');
  await page.getByLabel('Account type').selectOption('revenue');
  await expect(page.getByText('Normal balance: Credit',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Create ledger account'}).click();
  await expect(page.getByRole('alert')).toContainText('already has');
  await expect(page.getByLabel('Account name')).toHaveValue('Travel');
});
