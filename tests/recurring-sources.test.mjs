import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { id, initializeDatabase } from './accounting-fixture.mjs';
const db = new PGlite();
await initializeDatabase(db);
after(() => db.close());
const upsert = (account=8) => db.query(`select upsert_detected_recurring_candidate(
  $1,$2,'fun','monthly',89.40,0,3,'2026-07-09','2026-09-07','2026-10-07',0.7,'{}') as id`,[id(3),id(account)]);
async function scenario(fn) { await db.exec('begin'); try {await fn();} finally {await db.exec('rollback');} }
async function rejects(call, pattern) {
  const before=(await db.query(`select jsonb_build_object('candidates',(select jsonb_agg(r order by id) from recurring_transaction_candidates r),'audit',(select jsonb_agg(a order by id) from audit_log a),'vendors',(select jsonb_agg(v order by id) from vendors v)) as data`)).rows;
  await db.exec('savepoint rejected');await assert.rejects(call(),pattern);await db.exec('rollback to savepoint rejected');
  const after=(await db.query(`select jsonb_build_object('candidates',(select jsonb_agg(r order by id) from recurring_transaction_candidates r),'audit',(select jsonb_agg(a order by id) from audit_log a),'vendors',(select jsonb_agg(v order by id) from vendors v)) as data`)).rows;
  assert.deepEqual(after,before);
}
async function historical() {
  await db.exec(`insert into recurring_transaction_candidates(id,client_id,account_id,merchant_pattern,cadence,expected_amount,occurrence_count,first_occurrence_date,last_occurrence_date,confidence_score)
    values ('${id(90)}','${id(3)}','${id(7)}','fun','monthly',89.40,3,'2026-07-09','2026-09-07',0.7)`);
}
test('detection accepts only authoritative sources; review preserves financial records and audits',async()=>scenario(async()=>{
  const financial=(await db.query(`select jsonb_build_object('tx',(select jsonb_agg(t order by id) from transactions t),'journals',(select jsonb_agg(j order by id) from journal_entries j)) as data`)).rows;
  await rejects(()=>upsert(7),/financially active/);
  const candidate=(await upsert()).rows[0].id;
  await db.query(`select review_recurring_transaction_candidate($1,$2,'confirm')`,[candidate,id(3)]);
  const row=(await db.query('select * from recurring_transaction_candidates where id=$1',[candidate])).rows[0];
  assert.equal(row.status,'confirmed');assert.equal(row.reviewed_by,id(1));assert.ok(row.reviewed_at);
  assert.equal((await db.query("select count(*)::int n from audit_log where action='recurring_candidate_confirmed'")).rows[0].n,1);
  assert.deepEqual((await db.query(`select jsonb_build_object('tx',(select jsonb_agg(t order by id) from transactions t),'journals',(select jsonb_agg(j order by id) from journal_entries j)) as data`)).rows,financial);
  await rejects(()=>db.query(`select review_recurring_transaction_candidate($1,$2,'confirm')`,[candidate,id(3)]),/Only detected/);
}));
test('historical review and revoked/pending-source detection fail without mutations',async()=>scenario(async()=>{
  await historical();
  for(const action of ['confirm','dismiss']) await rejects(()=>db.query('select review_recurring_transaction_candidate($1,$2,$3)',[id(90),id(3),action]),/financially active/);
  for(const sql of ["update plaid_items set status='revoked'", "update plaid_items set status='active',financial_source_status='pending_review'"]) {
    await db.exec(`${sql} where id='${id(5)}'`);await rejects(()=>upsert(),/financially active/);
  }
}));
test('vendor linking changes active evidence only and rejects historical-only merchant',async()=>scenario(async()=>{
  await historical();const before=(await db.query(`select * from recurring_transaction_candidates where id='${id(90)}'`)).rows;
  await rejects(()=>db.query(`select create_or_link_vendor($1,'Fun','fun')`,[id(3)]),/active-source recurring/);
  const candidate=(await upsert()).rows[0].id;
  const vendor=(await db.query(`select create_or_link_vendor($1,'Fun','fun') as id`,[id(3)])).rows[0].id;
  assert.equal((await db.query('select vendor_id from recurring_transaction_candidates where id=$1',[candidate])).rows[0].vendor_id,vendor);
  assert.deepEqual((await db.query(`select * from recurring_transaction_candidates where id='${id(90)}'`)).rows,before);
}));
test('tenant, roles, grants and audit rollback protect review',async()=>scenario(async()=>{
  const candidate=(await upsert()).rows[0].id;
  const review=()=>db.query(`select review_recurring_transaction_candidate($1,$2,'confirm')`,[candidate,id(3)]);
  await rejects(()=>db.query(`select review_recurring_transaction_candidate($1,$2,'confirm')`,[candidate,id(30)]),/not found/);
  await db.exec("update firm_users set role='read_only'");await rejects(review,/not authorized/);
  await db.exec(`select set_config('test.user_id','',false)`);await rejects(review,/Authentication required/);
  await db.exec(`select set_config('test.user_id','${id(1)}',false); update firm_users set role='bookkeeper'`);
  await db.exec(`create function reject_recurring_audit() returns trigger language plpgsql as $$begin raise exception 'Audit rejected'; end;$$;
    create trigger reject_recurring_audit before insert on audit_log for each row execute function reject_recurring_audit()`);
  await rejects(review,/Audit rejected/);
  const grants=(await db.query(`select has_function_privilege('authenticated','upsert_detected_recurring_candidate(uuid,uuid,text,text,numeric,numeric,integer,date,date,date,numeric,jsonb)','execute') as detector,
    has_function_privilege('anon','review_recurring_transaction_candidate(uuid,uuid,text)','execute') as anon,
    has_function_privilege('authenticated','lock_active_recurring_account(uuid,uuid)','execute') as helper`)).rows[0];
  assert.deepEqual(grants,{detector:false,anon:false,helper:false});
}));
test('detector query excludes superseded/pending/revoked sources, removed transactions and duplicates',async()=>{
  const sourceText=await readFile(new URL('../lib/recurring-detection.ts',import.meta.url),'utf8');
  const {outputText}=ts.transpileModule(sourceText,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}});
  const {detectRecurringTransactionCandidates}=await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  const source=(status='active',financial_source_status='active')=>({client_id:'client',status,financial_source_status});
  const transactions=[];
  for(const [account,pi] of [['canonical',source()],['old',source('active','superseded')],['pending',source('active','pending_review')],['revoked',source('revoked')]]) {
    for(const [i,date] of ['2026-07-09','2026-08-08','2026-09-07'].entries()) transactions.push({id:`${account}-${i}`,account_id:account,client_id:'client',posted_date:date,amount:89.4,merchant_name:'FUN',plaid_removed_at:null,duplicate_of_transaction_id:null,accounts:{plaid_items:pi}});
  }
  transactions.push({...transactions[0],id:'removed',plaid_removed_at:'2026-09-08'});
  transactions.push({...transactions[0],id:'duplicate',duplicate_of_transaction_id:'canonical-0'});
  const calls=[];let rows=transactions;
  const value=(row,path)=>path.split('.').reduce((v,k)=>v?.[k],row);
  const query={select(){return query},eq(path,v){rows=rows.filter(r=>value(r,path)===v);return query},is(path,v){rows=rows.filter(r=>value(r,path)===v);return query},order(){return Promise.resolve({data:rows,error:null})}};
  const result=await detectRecurringTransactionCandidates({from(){return query},async rpc(name,args){calls.push({name,args});return {error:null}}},'client');
  assert.equal(result.scanned,3);assert.equal(calls.length,1);assert.equal(calls[0].args.p_account_id,'canonical');
  assert.deepEqual(calls[0].args.p_evidence.transaction_ids,['canonical-0','canonical-1','canonical-2']);
});
