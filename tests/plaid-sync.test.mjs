import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../lib/plaid-sync.ts', import.meta.url), 'utf8');
let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const modules = {
  '@/lib/error-details': 'const asErrorDetails = error => error || {};',
  plaid: `const Configuration=class {}; const PlaidEnvironments={sandbox:'fixture'}; const PlaidApi=class {transactionsSync(request){return globalThis.__plaidFixture.request(request)}};`,
  './plaid-token-storage': `const readPlaidAccessToken=async()=> 'fixture-token';`,
  './categorization': `const categorizeWithLocalRules=async()=>globalThis.__plaidFixture.detector('categorization');`,
  './duplicate-detection': `const detectDuplicateCandidates=async()=>globalThis.__plaidFixture.detector('duplicates');`,
  './recurring-detection': `const detectRecurringTransactionCandidates=async()=>globalThis.__plaidFixture.detector('recurring');`,
};
compiled = compiled.replace(/import[\s\S]*?from ['"]([^'"]+)['"];?/g, (_match, path) => {
  assert.ok(modules[path], `Unexpected dependency ${path}`); return modules[path];
});
compiled = 'const console={log(){},warn(){},error(){}};\n' + compiled;
const { syncPlaidItem } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const transaction = { transaction_id: 'provider-tx', account_id: 'provider-account', date: '2026-01-02', amount: 30, name: 'Updated merchant', category: ['Provider label'] };
const page = (changes = {}) => ({ data: { added: [], modified: [], removed: [], next_cursor: 'final', has_more: false, ...changes } });
function fixture(pages, options = {}) {
  const calls = [], requests = [], detectors = []; let next = 0;
  globalThis.__plaidFixture = {
    async request(request) { requests.push(request); const response = pages[next++]; if (response instanceof Error) throw response; assert.ok(response, 'Unexpected pagination call'); return response; },
    async detector(name) { detectors.push(name); return { categorized: 0, skipped: 0, scanned: 0, candidates: 0 }; },
  };
  const db = {
    from(table) {
      const filters = {}; let action = 'select', values;
      const query = { select() { return query; }, eq(key,value) { filters[key]=value; return query; }, is(key,value) { filters[key]=value; return query; },
        insert(value) { action='insert'; values=value; return query; }, update(value) { action='update'; values=value; return query; },
        async maybeSingle() { return execute(); }, then(resolve,reject) { return execute().then(resolve,reject); } };
      async function execute() {
        calls.push({ table, action, filters: { ...filters }, values });
        if (table === 'accounts') return { data: [{ id:'account',plaid_account_id:'provider-account' }], error:null };
        if (table === 'transactions') return { data: action==='insert'?null:(options.existing === false ? null : { id:'transaction',plaid_removed_at: options.removedAt || null }), error:null };
        if (table === 'provider_transaction_exceptions') return { data:options.pendingRemoval?{ id:'removal' }:null,error:options.lookupError?{ message:'lookup failed' }:null };
        if (table === 'plaid_items') return { data:options.cursorConflict?null:{ id:'item',cursor:'final' },error:null };
        throw new Error(`Unexpected table ${table}`);
      }
      return query;
    },
    async rpc(name,args) { calls.push({ name,args }); return { data:[{ outcome:'captured' }],error:options.rpcError?{ message:'ingestion failed' }:null }; },
  };
  return { calls,requests,detectors, run:()=>syncPlaidItem({ db,item:{ id:'item',client_id:'client',plaid_item_id:'provider-item',access_token_encrypted:null,token_key_version:1,cursor:'original' } }) };
}
test('added reappearance supersedes pending posted removal even without a soft-removal timestamp',async()=>{
  const f=fixture([page({ added:[transaction] })],{ pendingRemoval:true }); assert.equal((await f.run()).success,true);
  const rpc=f.calls.find(c=>c.name); assert.equal(rpc.name,'apply_or_capture_provider_transaction_change');
  assert.equal(rpc.args.p_event_type,'reappeared'); assert.equal(rpc.args.p_amount,30);
  const lookup=f.calls.find(c=>c.table==='provider_transaction_exceptions');
  assert.deepEqual(lookup.filters,{ client_id:'client',plaid_item_id:'item',transaction_id:'transaction',event_type:'removed',status:'open' });
});
test('ordinary added replay does not insert or mutate; soft-removed replay becomes reappearance',async()=>{
  const replay=fixture([page({ added:[transaction] })]); await replay.run(); assert.equal(replay.calls.filter(c=>c.name||c.action==='insert').length,0);
  const removed=fixture([page({ added:[transaction] })],{ removedAt:'2026-01-01' }); await removed.run(); assert.equal(removed.calls.find(c=>c.name).args.p_event_type,'reappeared');
  const fresh=fixture([page({ added:[transaction] })],{ existing:false }); await fresh.run(); assert.equal(fresh.calls.find(c=>c.action==='insert').values.status,'pending_review');
});
test('modified and deduplicated removed events use the atomic ingestion boundary before cursor commit',async()=>{
  const f=fixture([page({ modified:[transaction],removed:[{ transaction_id:'provider-tx' },{ transaction_id:'provider-tx' }] })]); await f.run();
  assert.deepEqual(f.calls.filter(c=>c.name).map(c=>c.args.p_event_type),['modified','removed']);
  assert.ok(f.calls.findIndex(c=>c.table==='plaid_items')>f.calls.findIndex(c=>c.name));
});
test('pagination mutation discards accumulated changes and restarts from original cursor',async()=>{
  const mutation=Object.assign(new Error('pagination changed'),{ error_code:'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' });
  const f=fixture([page({ added:[{ ...transaction,transaction_id:'discarded' }],next_cursor:'partial',has_more:true }),mutation,page({ modified:[transaction] })]); await f.run();
  assert.deepEqual(f.requests.map(r=>r.cursor),['original','partial','original']);
  assert.equal(f.calls.some(c=>c.values?.plaid_transaction_id==='discarded'),false);
  assert.equal(f.calls.filter(c=>c.name).length,1);
});
test('failed pagination or ingestion retains cursor and skips downstream detectors',async()=>{
  for (const make of [()=>fixture([page({ has_more:true,next_cursor:'partial' }),new Error('provider failure')]),()=>fixture([page({ modified:[transaction] })],{ rpcError:true }),()=>fixture([page({ added:[transaction] })],{ lookupError:true })]) {
    const f=make();
    assert.equal((await f.run()).success,false); assert.equal(f.calls.some(c=>c.table==='plaid_items'),false); assert.deepEqual(f.detectors,[]);
  }
});
test('cursor comparison failure prevents downstream categorization and detectors',async()=>{
  const f=fixture([page()],{ cursorConflict:true }); assert.equal((await f.run()).success,false);
  assert.equal(f.calls.find(c=>c.table==='plaid_items').filters.cursor,'original'); assert.deepEqual(f.detectors,[]);
});
