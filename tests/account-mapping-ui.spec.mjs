import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';

// Render the actual component in a test-only HTTP harness. All data is synthetic.
let server;
let baseURL;
test.beforeAll(async () => {
  const { outputFiles: [bundle] } = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import AccountingSetupPanel from './components/AccountingSetupPanel';
      const canManage = new URLSearchParams(location.search).get('readonly') !== '1';
      createRoot(document.getElementById('root')).render(<AccountingSetupPanel clientId="test-client" canManage={canManage}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  server = createServer((request,response) => {
    if (request.url === '/bundle.js') {
      response.writeHead(200, {'Content-Type':'application/javascript'});
      response.end(bundle.text);
    } else {
      response.writeHead(200, {'Content-Type':'text/html'});
      response.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
    }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(page, { readonly = false, error = '', successor = 'canonical-source' } = {}) {
  const posts = [];
  let transferred = false;
  await page.route('**/api/accounting-setup?*', route => route.fulfill({ json: {
    accounts: [{id:'canonical-checking',plaid_item_id:'canonical-source',name:'Plaid Checking',mask:'0000',type:'depository',subtype:'checking',coa_category_id:transferred?'operating-ledger':null}],
    categories: [{id:'operating-ledger',name:'Operating Checking',coa_code:'1000',account_type:'asset'}],
    transferSources: transferred ? [] : [{id:'old-checking',name:'Operating Checking',coa_category_id:'operating-ledger',plaid_items:{superseded_by_plaid_item_id:successor}}],
    canManage: !readonly,
  }}));
  await page.route('**/api/accounting-setup', async route => {
    posts.push(route.request().postDataJSON());
    if (error) return route.fulfill({ status:409,json:{error} });
    transferred = true;
    return route.fulfill({json:{success:true,accountId:'canonical-checking',coaCategoryId:'operating-ledger'}});
  });
  await page.goto(`${baseURL}/?readonly=${readonly?'1':'0'}`);
  await expect(page.getByText('Plaid Checking ••••0000 · checking', {exact:true})).toBeVisible();
  return posts;
}

test('review and transfer show both accounts; reload displays the new mapping', async ({page}) => {
  const posts = await setup(page);
  page.once('dialog', async dialog => {
    expect(dialog.message()).toContain('1000 · Operating Checking');
    expect(dialog.message()).toContain('Plaid Checking ••••0000');
    expect(dialog.message()).toContain('Historical transactions stay');
    await dialog.accept();
  });
  await page.getByRole('button',{name:'Transfer existing ledger mapping'}).click();
  await expect(page.getByText('Mapped to 1000 · Operating Checking · asset',{exact:true})).toBeVisible();
  expect(posts).toEqual([{clientId:'test-client',action:'transfer',accountId:'canonical-checking',fromAccountId:'old-checking',categoryId:'operating-ledger'}]);
  await expect(page.getByRole('button',{name:'Transfer existing ledger mapping'})).toHaveCount(0);
});

test('cancelled confirmation sends no mutation', async ({page}) => {
  const posts = await setup(page);
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button',{name:'Transfer existing ledger mapping'}).click();
  expect(posts).toHaveLength(0);
  await expect(page.getByRole('button',{name:'Transfer existing ledger mapping'})).toBeEnabled();
});

test('read-only user cannot transfer or choose an occupied mapping', async ({page}) => {
  const posts = await setup(page,{readonly:true});
  await expect(page.getByRole('button',{name:'Transfer existing ledger mapping'})).toBeDisabled();
  await expect(page.getByRole('combobox')).toBeDisabled();
  expect(posts).toHaveLength(0);
});

test('server rejection is visible and leaves the account unmapped', async ({page}) => {
  await setup(page,{error:'Both accounts must have zero reconciliations before a mapping transfer.'});
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button',{name:'Transfer existing ledger mapping'}).click();
  await expect(page.getByText('Both accounts must have zero reconciliations before a mapping transfer.',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Transfer existing ledger mapping'})).toBeEnabled();
  await expect(page.getByRole('option',{name:'1000 · Operating Checking · asset'})).toBeDisabled();
});

test('unrelated successor cannot be offered as a transfer candidate', async ({page}) => {
  await setup(page,{successor:'other-source'});
  await expect(page.getByRole('button',{name:'Transfer existing ledger mapping'})).toHaveCount(0);
});
