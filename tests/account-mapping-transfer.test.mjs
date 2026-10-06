import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Isolated PostgreSQL engine; no Supabase URL, credentials, or network calls.
const db = new PGlite();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
  create function auth.uid() returns uuid language sql as
    $$select nullif(current_setting('test.user_id', true), '')::uuid$$;
  create function uuid_generate_v4() returns uuid language sql as $$select gen_random_uuid()$$;
`);
for (const file of (await readdir(new URL('../schema/', import.meta.url))).sort()) {
  // Token encryption/Vault are external Supabase services, unrelated to this operation.
  const number = Number(file.slice(0, 3));
  if (!file.endsWith('.sql') || [2, 4, 5, 6].includes(number)) continue;
  let sql = await readFile(new URL(`../schema/${file}`, import.meta.url), 'utf8');
  sql = sql.replace(/^create extension .*;\r?\n/gm, '');
  try { await db.exec(sql); } catch (error) { throw new Error(`Migration ${file}: ${error.message}`); }
  if (number === 1) {
    // Existing migrations 018+ assume this legacy runtime column, but its
    // original addition is absent from the repository migration history.
    await db.exec('alter table transactions add column category text');
  }
}

await db.exec(`
  insert into auth.users(id) values ('${id(1)}');
  insert into firms(id,name) values ('${id(2)}','Test firm');
  insert into firm_users(firm_id,user_id,role) values ('${id(2)}','${id(1)}','bookkeeper');
  insert into clients(id,firm_id,business_name) values ('${id(3)}','${id(2)}','Test client');
  insert into clients(id,firm_id,business_name) values ('${id(30)}','${id(2)}','Other client');
  insert into plaid_items(id,client_id,plaid_item_id,access_token_encrypted,status)
    values ('${id(4)}','${id(3)}','old','\\x00','revoked'),
           ('${id(5)}','${id(3)}','canonical','\\x00','active');
  update plaid_items set financial_source_status='superseded',
    superseded_by_plaid_item_id='${id(5)}',superseded_at=now(),superseded_by='${id(1)}'
    where id='${id(4)}';
  insert into categories(id,client_id,name,coa_code,account_type,normal_balance,is_active,is_posting_account)
    values ('${id(6)}','${id(3)}','Operating Checking','1000','asset','debit',true,true),
           ('${id(60)}','${id(3)}','Expense','6000','expense','debit',true,true);
  insert into accounts(id,plaid_item_id,plaid_account_id,name,coa_category_id)
    values ('${id(7)}','${id(4)}','old-checking','Operating Checking','${id(6)}'),
           ('${id(8)}','${id(5)}','canonical-checking','Plaid Checking',null);
  insert into transactions(id,client_id,account_id,plaid_transaction_id,posted_date,amount,status,ai_category_id)
    values ('${id(9)}','${id(3)}','${id(7)}','old-tx','2026-01-01',25,'confirmed','${id(60)}'),
           ('${id(10)}','${id(3)}','${id(8)}','canonical-tx','2026-01-01',20,'confirmed','${id(60)}');
  select set_config('test.user_id','${id(1)}',false);
`);
const transfer = (client = 3, from = 7, to = 8, category = 6) => db.query(
  'select * from transfer_account_coa_mapping($1,$2,$3,$4)',
  [client, from, to, category].map(id),
);
const snapshot = async () => (await db.query(`select jsonb_build_object(
  'accounts',(select jsonb_agg(a order by id) from accounts a),
  'transactions',(select jsonb_agg(t order by id) from transactions t),
  'sources',(select jsonb_agg(p order by id) from plaid_items p),
  'audit',(select jsonb_agg(l order by id) from audit_log l)) as data`)).rows[0].data;
async function scenario(callback) {
  await db.exec('begin');
  try { await callback(); } finally { await db.exec('rollback'); }
}
async function rejectsUnchanged(pattern, call = transfer) {
  const before = await snapshot();
  await db.exec('savepoint rejection');
  await assert.rejects(call(), pattern);
  await db.exec('rollback to savepoint rejection');
  assert.deepEqual(await snapshot(), before);
}

test('transfer preserves history/source status and records both mappings; replay rejected', async () => scenario(async () => {
  const before = await snapshot();
  assert.deepEqual((await transfer()).rows, [{ account_id: id(8), coa_category_id: id(6) }]);
  const after = await snapshot();
  assert.equal(after.accounts.find(a => a.id === id(7)).coa_category_id, null);
  assert.equal(after.accounts.find(a => a.id === id(8)).coa_category_id, id(6));
  assert.deepEqual(after.transactions, before.transactions);
  assert.deepEqual(after.sources, before.sources);
  const audit = after.audit.find(a => a.action === 'connected_account_mapping_transferred');
  assert.equal(audit.actor_id, id(1));
  assert.equal(audit.detail.previous_from_coa_category_id, id(6));
  assert.equal(audit.detail.new_to_coa_category_id, id(6));
  await rejectsUnchanged(/Source mapping changed/);
}));

test('authorization, tenant, missing IDs, expected mapping, distinct accounts', async () => scenario(async () => {
  await rejectsUnchanged(/Source account not found/, () => transfer(30));
  await rejectsUnchanged(/Source account not found/, () => transfer(3, 99));
  await rejectsUnchanged(/Source mapping changed/, () => transfer(3, 7, 8, 60));
  await rejectsUnchanged(/distinct/, () => transfer(3, 7, 7));
  await db.exec(`update firm_users set role='read_only'`);
  await rejectsUnchanged(/access is required/);
  await db.exec(`select set_config('test.user_id','',false)`);
  await rejectsUnchanged(/Authentication required/);
}));

test('active or pending source, wrong successor, inactive destination and occupied mapping rejected', async () => {
  for (const status of ['active','pending_review']) await scenario(async () => {
    await db.exec(`update plaid_items set financial_source_status='${status}',
      superseded_by_plaid_item_id=null,superseded_at=null,superseded_by=null where id='${id(4)}'`);
    await rejectsUnchanged(/already be superseded/);
  });
  await scenario(async () => {
    await db.exec(`update plaid_items set status='revoked' where id='${id(5)}'`);
    await rejectsUnchanged(/provider-active/);
  });
  await scenario(async () => {
    await db.exec(`update plaid_items set financial_source_status='pending_review' where id='${id(5)}'`);
    await rejectsUnchanged(/provider-active/);
  });
  await scenario(async () => {
    await db.exec(`insert into plaid_items(id,client_id,plaid_item_id,access_token_encrypted)
      values ('${id(50)}','${id(3)}','wrong-successor','\\x00');
      update plaid_items set superseded_by_plaid_item_id='${id(50)}' where id='${id(4)}'`);
    await rejectsUnchanged(/already be superseded/);
  });
  await scenario(async () => {
    await db.exec(`insert into categories(id,client_id,name,account_type,normal_balance,is_active,is_posting_account)
      values ('${id(61)}','${id(3)}','Other asset','asset','debit',true,true);
      update accounts set coa_category_id='${id(61)}' where id='${id(8)}'`);
    await rejectsUnchanged(/Destination must be unmapped/);
  });
});

test('ineligible ledger and all reconciliation history rejected', async () => {
  await scenario(async () => {
    await db.exec(`update categories set is_active=false where id='${id(6)}'`);
    await rejectsUnchanged(/not eligible/);
  });
  for (const account of [7,8]) for (const status of ['in_progress','needs_attention','completed']) {
    await scenario(async () => {
      await db.exec(`insert into reconciliations(client_id,account_id,period_start,period_end,status)
        values ('${id(3)}','${id(account)}','2026-01-01','2026-01-31','${status}')`);
      await rejectsUnchanged(/zero reconciliations/);
    });
  }
});

test('draft and posted journals block transfer on either account', async () => {
  for (const transaction of [9,10]) await scenario(async () => {
    const { rows: [journal] } = await db.query(`insert into journal_entries(client_id,transaction_id,entry_date,created_by)
      values ('${id(3)}','${id(transaction)}','2026-01-01','${id(1)}') returning id`);
    await rejectsUnchanged(/zero active journals/);
    await db.query(`insert into journal_lines(journal_entry_id,category_id,debit,credit) values
      ($1,'${id(6)}',25,0),($1,'${id(60)}',0,25)`, [journal.id]);
    await db.query('select post_journal_entry($1)', [journal.id]);
    await rejectsUnchanged(/zero active journals/);
  });
});

test('audit failure rolls back both mapping updates', async () => scenario(async () => {
  await db.exec(`create function fail_transfer_audit() returns trigger language plpgsql as
    $$begin raise exception 'test audit unavailable'; end;$$;
    create trigger fail_transfer_audit before insert on audit_log for each row execute function fail_transfer_audit()`);
  await rejectsUnchanged(/test audit unavailable/);
}));

test('transferred account posts balanced journal; source and closed-period protections persist', async () => scenario(async () => {
  await transfer();
  await db.exec('savepoint posting');
  await assert.rejects(db.query('select post_transaction_to_journal($1,$2)',[id(9),id(3)]), /non-active|provider-inactive/);
  await db.exec('rollback to savepoint posting');
  const { rows: [result] } = await db.query('select post_transaction_to_journal($1,$2) as id',[id(10),id(3)]);
  const totals = (await db.query('select sum(debit) as debit,sum(credit) as credit from journal_lines where journal_entry_id=$1',[result.id])).rows[0];
  assert.equal(totals.debit, totals.credit);
  assert.equal(Number(totals.debit),20);
  await db.exec(`insert into reconciliations(client_id,account_id,period_start,period_end,status)
    values ('${id(3)}','${id(8)}','2026-01-01','2026-01-31','completed')`);
  await db.exec('savepoint closed');
  await assert.rejects(db.query('select post_transaction_to_journal($1,$2)',[id(10),id(3)]), /completed reconciliation period/);
  await db.exec('rollback to savepoint closed');
}));

test('RPC privileges exclude anonymous access', async () => {
  const { rows: [permissions] } = await db.query(`select
    has_function_privilege('anon','transfer_account_coa_mapping(uuid,uuid,uuid,uuid)','execute') as anonymous,
    has_function_privilege('authenticated','transfer_account_coa_mapping(uuid,uuid,uuid,uuid)','execute') as authenticated`);
  assert.deepEqual(permissions, { anonymous: false, authenticated: true });
  await db.close();
});
