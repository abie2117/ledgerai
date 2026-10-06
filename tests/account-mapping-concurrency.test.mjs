import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { id, initializeDatabase } from './accounting-fixture.mjs';

const connection = new URL(process.env.LEDGERAI_TEST_DATABASE_URL || '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname)
    || !/^\/ledgerai_[a-z0-9_]+_test$/.test(connection.pathname)) {
  throw new Error('Concurrency tests require a disposable local ledgerai_*_test database.');
}
const template = connection.pathname.slice(1);
const adminUrl = new URL(connection);
adminUrl.pathname = '/postgres';
const admin = new pg.Client({ connectionString: adminUrl.href });
await admin.connect();
const fixture = new pg.Client({ connectionString: connection.href });
await fixture.connect();
await initializeDatabase({ exec: (sql) => fixture.query(sql) });
await fixture.end();
let caseNumber = 0;
after(async () => { await admin.end(); });

async function sessions(callback) {
  const database = `ledgerai_transfer_${process.pid}_${++caseNumber}_test`;
  await admin.query(`create database ${database} template ${template}`);
  const url = new URL(connection);
  url.pathname = `/${database}`;
  const clients = [0,1,2].map(() => new pg.Client({ connectionString: url.href }));
  try {
    await Promise.all(clients.map(async (client) => {
      await client.connect();
      await client.query(`set statement_timeout='10s'; set lock_timeout='8s'`);
      await client.query("select set_config('test.user_id',$1,false)", [id(1)]);
    }));
    await callback(...clients);
  } finally {
    // Closing sessions also rolls back any still-open transaction on failure.
    await Promise.all(clients.map(client => client.end()));
    await admin.query(`drop database ${database}`);
  }
}
const transfer = client => client.query('select * from transfer_account_coa_mapping($1,$2,$3,$4)', [3,7,8,6].map(id));
const post = client => client.query('select post_transaction_to_journal($1,$2) as id', [10,3].map(id));
const reconcileOld = client => client.query(`select start_account_reconciliation($1,$2,'2026-01-01','2026-01-31',0,0,0)`, [3,7].map(id));

function pending(query) {
  // Attach rejection handling immediately so an unexpected fast failure is visible.
  return query.then(value => ({ value }), error => ({ error }));
}
async function waitForLock(observer, pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows: [state] } = await observer.query('select wait_event_type from pg_stat_activity where pid=$1', [pid]);
    if (state?.wait_event_type === 'Lock') return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail('Expected the second database connection to wait for a lock.');
}
async function runBlocked(first, second, observer, firstAction, secondAction, expectedError) {
  await first.query('begin');
  await firstAction(first);
  const { rows: [{ pid }] } = await second.query('select pg_backend_pid() as pid');
  const result = pending(secondAction(second));
  await waitForLock(observer, pid);
  await first.query('commit');
  const settled = await result;
  if (expectedError) {
    assert.ok(settled.error, 'Competing operation must fail after revalidation.');
    assert.match(settled.error.message, expectedError);
    assert.notEqual(settled.error.code, '40P01', 'A deadlock must not be mistaken for a business rejection.');
  } else {
    assert.ifError(settled.error);
  }
  return settled.value;
}
async function assertMapping(client, transferred = true) {
  const { rows } = await client.query('select id,coa_category_id from accounts where id=any($1::uuid[]) order by id', [[id(7),id(8)]]);
  assert.deepEqual(rows.map(row => row.coa_category_id), transferred ? [null,id(6)] : [id(6),null]);
  const { rows: [{ count }] } = await client.query("select count(*)::int as count from audit_log where action='connected_account_mapping_transferred'");
  assert.equal(count, transferred ? 1 : 0);
}

test('posting waits for transfer commit and uses the committed mapping', async () => sessions(async (a,b,observer) => {
  const result = await runBlocked(a,b,observer,transfer,post);
  await assertMapping(observer);
  const { rows: [totals] } = await observer.query('select sum(debit) as debit,sum(credit) as credit from journal_lines where journal_entry_id=$1', [result.rows[0].id]);
  assert.equal(totals.debit, totals.credit);
  assert.equal(Number(totals.debit),20);
}));

test('two transfer requests serialize; stale loser creates no second audit', async () => sessions(async (a,b,observer) => {
  await runBlocked(a,b,observer,transfer,transfer,/Source mapping changed/);
  await assertMapping(observer);
}));

test('revocation commits before a waiting transfer; mapping remains unchanged', async () => sessions(async (a,b,observer) => {
  await runBlocked(a,b,observer,client => client.query("update plaid_items set status='revoked' where id=$1", [id(5)]), transfer,/provider-active/);
  await assertMapping(observer,false);
}));

test('reconciliation starts first; waiting transfer sees new history and rejects', async () => sessions(async (a,b,observer) => {
  await runBlocked(a,b,observer,reconcileOld,transfer,/zero reconciliations/);
  await assertMapping(observer,false);
}));

test('transfer starts first; waiting reconciliation rejects the released mapping', async () => sessions(async (a,b,observer) => {
  await runBlocked(a,b,observer,transfer,reconcileOld,/Account must be mapped/);
  await assertMapping(observer);
}));

test('ordinary mapping cannot steal the transferred unique ledger account', async () => sessions(async (a,b,observer) => {
  await observer.query(`insert into accounts(id,plaid_item_id,plaid_account_id,name)
    values ($1,$2,'third-account','Other Checking')`,[id(11),id(5)]);
  await runBlocked(a,b,observer,transfer,client => client.query("select mutate_accounting_setup($1,$2,'map',$3)",[3,11,6].map(id)),/duplicate key/);
  await assertMapping(observer);
}));

const detectRecurring = client => client.query(`select upsert_detected_recurring_candidate($1,$2,'fun','monthly',89.4,0,3,'2026-07-09','2026-09-07','2026-10-07',0.7,'{}') as id`,[3,8].map(id));
test('recurring detection waits for revocation and rejects the now-inactive source',async()=>sessions(async(a,b,observer)=>{
  await runBlocked(a,b,observer,c=>c.query("update plaid_items set status='revoked' where id=$1",[id(5)]),detectRecurring,/financially active/);
  assert.equal((await observer.query('select count(*)::int n from recurring_transaction_candidates')).rows[0].n,0);
}));
test('recurring review waits for supersession and preserves candidate history',async()=>sessions(async(a,b,observer)=>{
  const candidate=(await detectRecurring(observer)).rows[0].id;
  await runBlocked(a,b,observer,c=>c.query(`update plaid_items set financial_source_status='superseded',superseded_by_plaid_item_id=$1,superseded_by=$2,superseded_at=now() where id=$3`,[4,1,5].map(id)),
    c=>c.query(`select review_recurring_transaction_candidate($1,$2,'confirm')`,[candidate,id(3)]),/financially active/);
  assert.equal((await observer.query('select status from recurring_transaction_candidates where id=$1',[candidate])).rows[0].status,'detected');
  assert.equal((await observer.query("select count(*)::int n from audit_log where action='recurring_candidate_confirmed'")).rows[0].n,0);
}));
