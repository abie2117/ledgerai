import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { id, initializeDatabase } from './accounting-fixture.mjs';
const db = new PGlite();
await initializeDatabase(db);
const create = (name = 'Travel', code = '6110', type = 'expense', client = id(3)) =>
  db.query('select create_client_ledger_account($1,$2,$3,$4) as id', [client, name, code, type]);
async function scenario(fn) { await db.exec('begin'); try { await fn(); } finally { await db.exec('rollback'); } }
async function rejects(call, pattern) {
  const before = (await db.query('select count(*)::int as n from categories')).rows;
  await db.exec('savepoint rejected');
  await assert.rejects(call(), pattern);
  await db.exec('rollback to savepoint rejected');
  assert.deepEqual((await db.query('select count(*)::int as n from categories')).rows, before);
}
test('client expense creation preserves shared categories, audits, and supports balanced posting', async () => scenario(async () => {
  await db.exec(`insert into categories(id,name,coa_code) values ('${id(90)}','Travel','6110')`);
  const original = (await db.query(`select * from categories where id='${id(90)}'`)).rows;
  const category = (await create()).rows[0].id;
  const row = (await db.query('select * from categories where id=$1', [category])).rows[0];
  assert.equal(row.client_id, id(3)); assert.equal(row.account_type, 'expense');
  assert.equal(row.normal_balance, 'debit'); assert.equal(row.is_active, true);
  assert.equal(row.is_posting_account, true); assert.equal(row.is_default, false);
  assert.deepEqual((await db.query(`select * from categories where id='${id(90)}'`)).rows, original);
  const audit = (await db.query(`select * from audit_log where action='client_ledger_account_created'`)).rows;
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, id(1));
  assert.equal(audit[0].detail.category_id, category);
  await db.exec(`select * from transfer_account_coa_mapping('${id(3)}','${id(7)}','${id(8)}','${id(6)}')`);
  await db.query('update transactions set ai_category_id=$1 where id=$2', [category, id(10)]);
  await db.exec(`select post_transaction_to_journal('${id(10)}','${id(3)}')`);
  const balance = (await db.query('select sum(debit) as debit, sum(credit) as credit from journal_lines')).rows[0];
  assert.equal(Number(balance.debit), 20); assert.equal(Number(balance.credit), 20);
}));
test('all account types derive the required normal balance', async () => scenario(async () => {
  for (const type of ['asset','liability','equity','revenue','expense']) {
    const category = (await create(`New ${type}`, type, type)).rows[0].id;
    const row = (await db.query('select normal_balance from categories where id=$1', [category])).rows[0];
    assert.equal(row.normal_balance, ['asset','expense'].includes(type) ? 'debit' : 'credit');
  }
}));
test('reject anonymous, viewer, unrelated tenant, invalid values and duplicate client codes/names', async () => scenario(async () => {
  await rejects(() => create('Travel','6110',null), /valid account type/);
  await rejects(() => create(' ','6110'), /name/);
  await rejects(() => create('Travel',' '), /code/);
  await rejects(() => create('Travel','6110','other'), /valid account type/);
  await rejects(() => create('Travel','6110','expense',id(99)), /access is required/);
  await db.exec(`insert into firms(id,name) values ('${id(91)}','Unrelated'); insert into clients(id,firm_id,business_name) values ('${id(92)}','${id(91)}','Unrelated')`);
  await rejects(() => create('Travel','6110','expense',id(92)), /access is required/);
  await create();
  await rejects(() => create('Another','6110'), /already has/);
  await rejects(() => create(' travel ','6120'), /already has/);
  await create('Travel','6110','expense',id(30));
  await db.exec(`update firm_users set role='read_only'`);
  await rejects(() => create('Office','6200'), /access is required/);
  await db.exec(`select set_config('test.user_id','',false)`);
  await rejects(() => create('Office','6200'), /Authentication required/);
  assert.equal((await db.query(`select has_function_privilege('anon','create_client_ledger_account(uuid,text,text,text)','execute') as allowed`)).rows[0].allowed, false);
}));
test('audit failure rolls back the account creation', async () => scenario(async () => {
  await db.exec(`create function reject_chart_audit() returns trigger language plpgsql as $$begin raise exception 'Audit rejected'; end;$$;
    create trigger reject_chart_audit before insert on audit_log for each row execute function reject_chart_audit()`);
  await rejects(() => create(), /Audit rejected/);
}));
after(() => db.close());
