import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { id, initializeDatabase } from './accounting-fixture.mjs';
const db = new PGlite();
await initializeDatabase(db);
after(() => db.close());
async function scenario(fn) { await db.exec('begin'); try { await fn(); } finally { await db.exec('rollback'); } }
const change = (event, amount = 30) => db.query(`select * from apply_or_capture_provider_transaction_change($1,$2,'canonical-tx',$3,$4,'2026-01-02',$5,'Updated merchant','Provider label')`, [id(3), id(5), event, id(8), amount]);
const resolve = (exception, action = 'accept') => db.query(`select * from resolve_provider_transaction_exception($1,$2,$3,'Reviewed fixture evidence')`, [exception, id(3), action]);
const tx = async () => (await db.query('select * from transactions where id=$1', [id(10)])).rows[0];
const entries = async () => (await db.query('select * from journal_entries order by id')).rows;
async function post() {
  await db.query('select * from transfer_account_coa_mapping($1,$2,$3,$4)', [3,7,8,6].map(id));
  return (await db.query('select post_transaction_to_journal($1,$2) id', [10,3].map(id))).rows[0].id;
}
async function rejects(fn, pattern) {
  await db.exec('savepoint rejected'); await assert.rejects(fn(), pattern); await db.exec('rollback to savepoint rejected');
}
test('unjournaled modified, removed and reappeared events preserve identity and bookkeeping', async () => scenario(async () => {
  const original = await tx();
  assert.equal((await change('modified')).rows[0].outcome, 'applied');
  let row = await tx(); assert.equal(Number(row.amount), 30); assert.equal(row.merchant_name, 'Updated merchant');
  assert.equal(row.id, original.id); assert.equal(row.status, original.status); assert.equal(row.ai_category_id, original.ai_category_id);
  await change('removed'); assert.ok((await tx()).plaid_removed_at);
  await change('reappeared', 35); row = await tx(); assert.equal(row.plaid_removed_at, null); assert.equal(Number(row.amount), 35);
  assert.equal(row.status, original.status); assert.equal(row.ai_category_id, original.ai_category_id);
  assert.equal((await db.query('select count(*)::int n from transactions')).rows[0].n, 2);
  assert.equal((await entries()).length, 0);
}));
test('posted modifications capture evidence, replay reuses it and acceptance reverses/reposts atomically', async () => scenario(async () => {
  const originalJournal = await post(), original = await tx(), journals = await entries();
  const first = (await change('modified')).rows[0]; assert.equal(first.outcome, 'captured');
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
  const replay = (await change('modified', 32)).rows[0]; assert.equal(replay.provider_exception_id, first.provider_exception_id);
  const result = (await resolve(first.provider_exception_id)).rows[0]; assert.equal(result.journal_reposted, true);
  assert.equal(Number((await tx()).amount), 32);
  assert.equal((await db.query('select status from journal_entries where id=$1', [originalJournal])).rows[0].status, 'reversed');
  const all = await entries(); assert.equal(all.length, 3);
  const totals = (await db.query('select journal_entry_id,sum(debit) debit,sum(credit) credit from journal_lines group by journal_entry_id')).rows;
  for (const total of totals) assert.equal(total.debit, total.credit);
  await rejects(() => resolve(first.provider_exception_id), /no longer open/);
  assert.equal((await db.query("select count(*)::int n from audit_log where action='provider_transaction_exception_accepted'")).rows[0].n, 1);
}));
test('posted removal followed by reappearance supersedes removal without changing journals', async () => scenario(async () => {
  await post(); const original = await tx(), journals = await entries();
  const removed = (await change('removed')).rows[0]; assert.equal((await tx()).plaid_removed_at, null);
  const reappeared = (await change('reappeared')).rows[0];
  assert.equal((await db.query('select status from provider_transaction_exceptions where id=$1', [removed.provider_exception_id])).rows[0].status, 'superseded');
  await rejects(() => resolve(removed.provider_exception_id), /no longer open/);
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
  await resolve(reappeared.provider_exception_id, 'dismiss');
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
}));
test('accepted removal retains transaction and reversal; reappearance applies without automatic repost', async () => scenario(async () => {
  await post(); const removed = (await change('removed')).rows[0];
  await resolve(removed.provider_exception_id); assert.ok((await tx()).plaid_removed_at);
  assert.equal((await entries()).length, 2);
  assert.equal((await change('reappeared')).rows[0].outcome, 'applied');
  assert.equal((await tx()).plaid_removed_at, null); assert.equal((await entries()).length, 2);
  assert.equal((await db.query('select count(*)::int n from transactions')).rows[0].n, 2);
}));
test('tenant, account, role, malformed values and grants reject unauthorized lifecycle operations', async () => scenario(async () => {
  await rejects(() => db.query(`select * from apply_or_capture_provider_transaction_change($1,$2,'canonical-tx','removed')`, [id(30),id(5)]), /does not belong/);
  await rejects(() => db.query(`select * from apply_or_capture_provider_transaction_change($1,$2,'canonical-tx','modified',$3,'2026-01-02',30)`, [3,5,7].map(id)), /outside/);
  await rejects(() => db.query(`select * from apply_or_capture_provider_transaction_change($1,$2,'canonical-tx','modified')`, [3,5].map(id)), /incomplete/);
  await post(); const evidence = (await change('removed')).rows[0];
  await db.exec("update firm_users set role='read_only'"); await rejects(() => resolve(evidence.provider_exception_id), /not authorized/);
  await db.exec("update firm_users set role='bookkeeper'"); await rejects(() => resolve(evidence.provider_exception_id, null), /accept or dismiss/);
  const grants = (await db.query(`select has_function_privilege('authenticated','apply_or_capture_provider_transaction_change(uuid,uuid,text,text,uuid,date,numeric,text,text)','execute') ingestion, has_function_privilege('anon','resolve_provider_transaction_exception(uuid,uuid,text,text)','execute') review`)).rows[0];
  assert.deepEqual(grants, { ingestion: false, review: false });
}));
test('audit failure rolls back accepted changes and all reversal/repost writes', async () => scenario(async () => {
  await post(); const evidence = (await change('modified')).rows[0]; const original = await tx(), journals = await entries();
  await db.exec(`create function reject_provider_audit() returns trigger language plpgsql as $$begin if new.action='provider_transaction_exception_accepted' then raise exception 'fixture audit failure'; end if; return new; end$$; create trigger reject_provider_audit before insert on audit_log for each row execute function reject_provider_audit()`);
  await rejects(() => resolve(evidence.provider_exception_id), /fixture audit failure/);
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
  assert.equal((await db.query('select status from provider_transaction_exceptions where id=$1', [evidence.provider_exception_id])).rows[0].status, 'open');
}));
test('completed reconciliation blocks provider acceptance while preserving captured evidence', async () => scenario(async () => {
  await post();
  const reconciliation = (await db.query(`select start_account_reconciliation($1,$2,'2026-01-01','2026-01-31',0,0,-20) id`, [3,8].map(id))).rows[0].id;
  await db.query('select * from complete_account_reconciliation($1,$2)', [reconciliation,id(3)]);
  const evidence = (await change('removed')).rows[0]; const original = await tx(), journals = await entries();
  await rejects(() => resolve(evidence.provider_exception_id), /completed reconciliation/);
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
  assert.equal((await db.query('select status from reconciliations where id=$1',[reconciliation])).rows[0].status, 'completed');
}));
test('draft journal captures provider evidence and prevents acceptance', async () => scenario(async () => {
  await db.query(`insert into journal_entries(client_id,transaction_id,entry_date,status,created_by) values ($1,$2,'2026-01-01','draft',$3)`, [3,10,1].map(id));
  const original = await tx(), journals = await entries(); const evidence = (await change('modified')).rows[0];
  assert.equal(evidence.outcome, 'captured'); await rejects(() => resolve(evidence.provider_exception_id), /active draft/);
  assert.deepEqual(await tx(), original); assert.deepEqual(await entries(), journals);
}));
