import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../lib/plaid-sandbox-refresh.ts', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
compiled = compiled.replace(/import 'server-only';/, '').replace(/import .* from 'plaid';/, `const Configuration=class {}; const PlaidEnvironments={sandbox:'sandbox'}; const PlaidApi=class {transactionsRefresh(request){globalThis.__sandboxRequests.push(request); return Promise.resolve({});}};`).replace(/import .* from '.\/plaid-token-storage';/, `const readPlaidAccessToken=async()=>{globalThis.__sandboxDecrypts++; return 'private-fixture-token';};`);
const { canGenerateSandboxUpdate, generateSandboxUpdate } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const item = { id:'connection',client_id:'client',status:'active',financial_source_status:'pending_review',plaid_item_id:'provider-item',token_key_version:2,access_token_encrypted:'encrypted' };
function configure(env = 'sandbox') {
  process.env.PLAID_ENV=env; process.env.PLAID_SANDBOX_TEST_CLIENT_ID='client'; process.env.PLAID_SANDBOX_TEST_CONNECTION_ID='connection';
  globalThis.__sandboxRequests=[]; globalThis.__sandboxDecrypts=0;
}
test('test control fails closed for environment, client, connection, provider and financial status',async()=>{
  for (const [env,changes] of [['production',{}],['development',{}],['sandbox',{client_id:'other'}],['sandbox',{id:'other'}],['sandbox',{status:'revoked'}],['sandbox',{financial_source_status:'active'}],['sandbox',{financial_source_status:'superseded'}]]) {
    configure(env); await assert.rejects(generateSandboxUpdate({...item,...changes}));
    assert.equal(globalThis.__sandboxDecrypts,0); assert.deepEqual(globalThis.__sandboxRequests,[]);
  }
  configure(); delete process.env.PLAID_SANDBOX_TEST_CONNECTION_ID;
  assert.equal(canGenerateSandboxUpdate('client','connection','active','pending_review'),false);
});
test('enabled isolated connection calls provider refresh and never returns the token',async()=>{
  configure(); assert.equal(await generateSandboxUpdate(item),undefined);
  assert.deepEqual(globalThis.__sandboxRequests,[{access_token:'private-fixture-token'}]);
  assert.equal(globalThis.__sandboxDecrypts,1);
});
