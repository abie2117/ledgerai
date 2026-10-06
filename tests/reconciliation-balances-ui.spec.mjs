import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
let server, url;
test.beforeAll(async () => {
  const { outputFiles: [bundle] } = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Panel from './components/ReconciliationPanel';
      createRoot(document.getElementById('root')).render(<Panel clientId="client" canManage={true}/>);`, resolveDir:process.cwd(),loader:'tsx' },
    plugins: [{name:'synthetic-supabase',setup(b) {
      b.onResolve({filter:/^@\/lib\/supabase-browser$/}, () => ({path:'fixture',namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'}, () => ({contents:`
        const account={id:'checking',name:'Plaid Checking',mask:'0000',coa_category_id:'ledger'};
        const reconciliation={id:'reconciliation',account_id:'checking',period_start:'2026-09-01',period_end:'2026-09-30',status:'in_progress',opening_statement_balance:0,opening_book_balance:0,closing_statement_balance:6.33};
        export const supabase={from(table){const q={select(){return q},eq(){return q},order(){return Promise.resolve({data:table==='accounts'?[account]:[reconciliation],error:null})}};return q}};
      `,loader:'js'}));
    }}],
    bundle:true,write:false,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},
  });
  server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(bundle.contents)}else{res.writeHead(200,{'Content-Type':'text/html'});res.end('<div id="root"></div><script src="/bundle.js"></script>')}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve))});
async function setup(page){const posts=[];await page.route('**/api/reconciliations',route=>{posts.push(route.request().postDataJSON());return route.fulfill({json:{success:true}})});await page.goto(url);await page.getByRole('button',{name:'Edit balances'}).click();return posts;}
test('typing minus first preserves it and submits negative closing balance',async({page})=>{
  const posts=await setup(page);const field=page.getByRole('textbox',{name:'Statement closing balance'});
  await field.fill('');await field.pressSequentially('-');await expect(field).toHaveValue('-');
  await field.pressSequentially('6.33');await expect(field).toHaveValue('-6.33');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText('Statement and book balances updated.',{exact:true})).toBeVisible();
  expect(posts).toEqual([{clientId:'client',action:'update_balances',reconciliationId:'reconciliation',openingStatementBalance:'0',openingBookBalance:'0',closingStatementBalance:'-6.33'}]);
});
test('inserting complete negative value is preserved',async({page})=>{
  await setup(page);const field=page.getByRole('textbox',{name:'Statement closing balance'});
  await field.selectText();await page.keyboard.insertText('-6.33');await expect(field).toHaveValue('-6.33');
});
test('invalid balances are blocked before mutation',async({page})=>{
  const posts=await setup(page);await page.getByRole('textbox',{name:'Statement closing balance'}).fill('-');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await expect(page.getByText(/Enter all three balances as amounts/)).toBeVisible();expect(posts).toHaveLength(0);
});
test('start form submits signed balances',async({page})=>{
  const posts=await setup(page);await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByLabel('Connected account').selectOption('checking');
  await page.getByLabel('Period start').fill('2026-09-01');await page.getByLabel('Period end').fill('2026-09-30');
  await page.getByLabel('Statement opening balance').fill('-10.00');await page.getByLabel('Book opening balance').fill('-10.00');
  await page.getByLabel('Statement closing balance').fill('-16.33');await page.getByRole('button',{name:'Start reconciliation'}).click();
  await expect(page.getByText('Reconciliation started. Complete it only after the statement and book balances agree.')).toBeVisible();
  expect(posts[0]).toMatchObject({action:'start',openingStatementBalance:'-10.00',openingBookBalance:'-10.00',closingStatementBalance:'-16.33'});
});
