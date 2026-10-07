import { readFile, readdir } from 'node:fs/promises';

export const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

export async function initializeDatabase(db) {
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
}
