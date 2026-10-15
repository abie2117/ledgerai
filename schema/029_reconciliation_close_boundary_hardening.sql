-- ============================================================
-- MIGRATION 029
-- RECONCILIATION CLOSE-BOUNDARY CONCURRENCY HARDENING
--
-- Serializes reconciliation periods per connected account, locks the
-- transaction population before completion, and prevents new postings from
-- entering a completed reconciliation period.
-- ============================================================

create or replace function start_account_reconciliation(
  p_client_id uuid,
  p_account_id uuid,
  p_period_start date,
  p_period_end date,
  p_opening_statement_balance numeric,
  p_opening_book_balance numeric,
  p_closing_statement_balance numeric
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_reconciliation_id uuid;
begin
  if v_user_id is null then raise exception 'Authentication required.'; end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'A valid reconciliation period is required.';
  end if;
  if p_opening_statement_balance is null or p_opening_book_balance is null or p_closing_statement_balance is null then
    raise exception 'Opening statement, opening book, and closing statement balances are required.';
  end if;
  if not exists (
    select 1 from clients c join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = v_user_id
      and fu.role in ('owner','admin','bookkeeper')
  ) then
    raise exception 'User is not authorized to reconcile accounts for this client.';
  end if;

  -- Serialize period creation and completion/posting boundaries on this account.
  perform a.id
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  join categories coa on coa.id = a.coa_category_id
  where a.id = p_account_id
    and pi.client_id = p_client_id
    and coa.client_id = p_client_id
    and coa.account_type in ('asset','liability')
    and coa.normal_balance in ('debit','credit')
    and coa.is_active and coa.is_posting_account
  for update of a;

  if not found then
    raise exception 'Account must be mapped to an active client asset or liability posting account before reconciliation.';
  end if;

  if exists (
    select 1 from reconciliations r
    where r.client_id = p_client_id and r.account_id = p_account_id
      and r.status in ('in_progress','completed','needs_attention')
      and daterange(r.period_start,r.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')
  ) then
    raise exception 'This account already has an overlapping active or completed reconciliation period.';
  end if;

  insert into reconciliations (
    client_id,account_id,period_start,period_end,status,
    opening_statement_balance,opening_book_balance,closing_statement_balance,summary
  ) values (
    p_client_id,p_account_id,p_period_start,p_period_end,'in_progress',
    round(p_opening_statement_balance,2),round(p_opening_book_balance,2),
    round(p_closing_statement_balance,2),'{}'::jsonb
  ) returning id into v_reconciliation_id;

  insert into audit_log (actor_id,client_id,action,detail)
  values (v_user_id,p_client_id,'account_reconciliation_started',
    jsonb_build_object('reconciliation_id',v_reconciliation_id,'account_id',p_account_id,
      'period_start',p_period_start,'period_end',p_period_end));

  return v_reconciliation_id;
end;
$$;

create or replace function complete_account_reconciliation(
  p_reconciliation_id uuid,
  p_client_id uuid
)
returns table (
  reconciliation_id uuid,
  book_movement numeric,
  book_closing_balance numeric,
  difference numeric,
  included_journal_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_reconciliation reconciliations%rowtype;
  v_source_category categories%rowtype;
  v_movement numeric(14,2) := 0;
  v_book_closing numeric(14,2);
  v_difference numeric(14,2);
  v_count integer := 0;
begin
  if v_user_id is null then raise exception 'Authentication required.'; end if;
  if not exists (
    select 1 from clients c join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = v_user_id
      and fu.role in ('owner','admin','bookkeeper')
  ) then
    raise exception 'User is not authorized to complete reconciliations for this client.';
  end if;

  select r.* into v_reconciliation
  from reconciliations r
  where r.id = p_reconciliation_id and r.client_id = p_client_id
  for update;
  if not found then raise exception 'Reconciliation not found.'; end if;
  if v_reconciliation.status not in ('in_progress','needs_attention') then
    raise exception 'Only an in-progress or needs-attention reconciliation can be completed.';
  end if;
  if v_reconciliation.account_id is null or v_reconciliation.opening_statement_balance is null
     or v_reconciliation.opening_book_balance is null or v_reconciliation.closing_statement_balance is null then
    raise exception 'Reconciliation setup is incomplete.';
  end if;
  if round(v_reconciliation.opening_statement_balance,2) <> round(v_reconciliation.opening_book_balance,2) then
    raise exception 'Opening statement and opening book balances must agree before completion.';
  end if;

  -- Same account lock used by start/posting to serialize the close boundary.
  perform a.id from accounts a
  where a.id = v_reconciliation.account_id
  for update;

  select coa.* into v_source_category
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  join categories coa on coa.id = a.coa_category_id
  where a.id = v_reconciliation.account_id and pi.client_id = p_client_id;
  if not found or v_source_category.client_id is distinct from p_client_id
     or v_source_category.account_type not in ('asset','liability')
     or v_source_category.normal_balance not in ('debit','credit')
     or not v_source_category.is_active or not v_source_category.is_posting_account then
    raise exception 'Reconciled account mapping is no longer eligible for posting.';
  end if;

  -- Freeze every transaction in the account/date population before calculating
  -- and snapshotting journals. post_transaction_to_journal takes the same row
  -- lock, so it cannot cross this close boundary.
  perform t.id
  from transactions t
  where t.client_id = p_client_id
    and t.account_id = v_reconciliation.account_id
    and t.posted_date between v_reconciliation.period_start and v_reconciliation.period_end
  order by t.id
  for update of t;

  perform je.id
  from journal_entries je
  join transactions t on t.id = je.transaction_id
  where je.client_id = p_client_id and t.client_id = p_client_id
    and t.account_id = v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null and je.status = 'posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  order by je.id
  for update of je;

  if exists (
    select 1 from journal_entries je join transactions t on t.id = je.transaction_id
    where je.client_id = p_client_id and t.client_id = p_client_id
      and t.account_id = v_reconciliation.account_id
      and je.reversal_of_journal_entry_id is null and je.status = 'draft'
      and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  ) then raise exception 'Active draft journals exist in the reconciliation period.'; end if;

  select coalesce(sum(case when v_source_category.normal_balance='debit'
      then jl.debit-jl.credit else jl.credit-jl.debit end),0)::numeric(14,2)
  into v_movement
  from journal_entries je
  join transactions t on t.id=je.transaction_id
  join journal_lines jl on jl.journal_entry_id=je.id and jl.category_id=v_source_category.id
  where je.client_id=p_client_id and t.client_id=p_client_id
    and t.account_id=v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null and je.status='posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end;

  v_book_closing := round(v_reconciliation.opening_book_balance + v_movement,2);
  v_difference := round(v_reconciliation.closing_statement_balance - v_book_closing,2);

  if v_difference <> 0 then
    update reconciliations set status='needs_attention',
      calculated_book_movement=v_movement,calculated_book_closing_balance=v_book_closing,
      reconciliation_difference=v_difference,
      summary=jsonb_build_object('book_movement',v_movement,'book_closing_balance',v_book_closing,
        'statement_closing_balance',closing_statement_balance,'difference',v_difference)
    where id=v_reconciliation.id;
    insert into audit_log(actor_id,client_id,action,detail)
    values(v_user_id,p_client_id,'account_reconciliation_needs_attention',
      jsonb_build_object('reconciliation_id',v_reconciliation.id,'account_id',v_reconciliation.account_id,
        'book_movement',v_movement,'book_closing_balance',v_book_closing,
        'statement_closing_balance',v_reconciliation.closing_statement_balance,'difference',v_difference));
    return query select v_reconciliation.id,v_movement,v_book_closing,v_difference,0;
    return;
  end if;

  insert into reconciliation_journal_entries(reconciliation_id,journal_entry_id)
  select v_reconciliation.id,je.id
  from journal_entries je join transactions t on t.id=je.transaction_id
  where je.client_id=p_client_id and t.client_id=p_client_id
    and t.account_id=v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null and je.status='posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  on conflict do nothing;
  get diagnostics v_count = row_count;

  update reconciliations set status='completed',calculated_book_movement=v_movement,
    calculated_book_closing_balance=v_book_closing,reconciliation_difference=0,
    reconciled_by=v_user_id,reconciled_at=now(),
    summary=jsonb_build_object('book_movement',v_movement,'book_closing_balance',v_book_closing,
      'statement_closing_balance',closing_statement_balance,'difference',0,'included_journal_count',v_count)
  where id=v_reconciliation.id;

  insert into audit_log(actor_id,client_id,action,detail)
  values(v_user_id,p_client_id,'account_reconciliation_completed',
    jsonb_build_object('reconciliation_id',v_reconciliation.id,'account_id',v_reconciliation.account_id,
      'book_movement',v_movement,'book_closing_balance',v_book_closing,'difference',0,
      'included_journal_count',v_count));

  return query select v_reconciliation.id,v_movement,v_book_closing,0::numeric,v_count;
end;
$$;

create or replace function post_transaction_to_journal(
  p_transaction_id uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction transactions%rowtype;
  v_source_category categories%rowtype;
  v_book_category categories%rowtype;
  v_journal_entry_id uuid;
  v_amount numeric(14,2);
  v_abs_amount numeric(14,2);
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;
  if not exists (
    select 1 from clients c join firm_users fu on fu.firm_id=c.firm_id
    where c.id=p_client_id and fu.user_id=auth.uid()
      and fu.role in ('owner','admin','bookkeeper')
  ) then raise exception 'User is not authorized to post transactions for this client.'; end if;

  select t.* into v_transaction
  from transactions t
  where t.id=p_transaction_id and t.client_id=p_client_id
  for update;
  if not found then raise exception 'Transaction not found.'; end if;
  if v_transaction.status <> 'confirmed' then raise exception 'Only confirmed transactions can be posted.'; end if;
  if v_transaction.duplicate_of_transaction_id is not null then raise exception 'Confirmed duplicate transactions cannot be posted.'; end if;
  if v_transaction.plaid_removed_at is not null then raise exception 'Provider-removed transactions cannot be posted.'; end if;
  if v_transaction.ai_category_id is null then raise exception 'Transaction must have a bookkeeping category before posting.'; end if;

  -- Serialize with reconciliation completion/start for this connected account.
  perform a.id from accounts a
  join plaid_items pi on pi.id=a.plaid_item_id
  where a.id=v_transaction.account_id and pi.client_id=p_client_id
  for update of a;
  if not found then raise exception 'Connected account does not belong to the selected client.'; end if;

  if exists (
    select 1 from reconciliations r
    where r.client_id=p_client_id and r.account_id=v_transaction.account_id
      and r.status='completed'
      and v_transaction.posted_date between r.period_start and r.period_end
  ) then
    raise exception 'Transaction falls inside a completed reconciliation period. Reopen that reconciliation before posting.';
  end if;

  if exists (
    select 1 from journal_entries je
    where je.transaction_id=v_transaction.id
      and je.reversal_of_journal_entry_id is null and je.status in ('draft','posted')
  ) then raise exception 'Transaction already has an active journal entry.'; end if;

  select c.* into v_book_category from categories c where c.id=v_transaction.ai_category_id;
  if not found or v_book_category.client_id is distinct from p_client_id
     or v_book_category.account_type is null or v_book_category.normal_balance is null
     or not v_book_category.is_active or not v_book_category.is_posting_account then
    raise exception 'Transaction category is not an eligible client posting account.';
  end if;

  select c.* into v_source_category
  from accounts a join plaid_items pi on pi.id=a.plaid_item_id
  join categories c on c.id=a.coa_category_id
  where a.id=v_transaction.account_id and pi.client_id=p_client_id;
  if not found or v_source_category.client_id is distinct from p_client_id
     or v_source_category.account_type not in ('asset','liability')
     or v_source_category.normal_balance is null
     or not v_source_category.is_active or not v_source_category.is_posting_account then
    raise exception 'Connected account is not mapped to an eligible client asset or liability posting account.';
  end if;
  if v_source_category.id=v_book_category.id then raise exception 'Source and categorized accounts must be different.'; end if;

  v_amount:=v_transaction.amount; v_abs_amount:=abs(v_amount);
  if v_abs_amount<=0 then raise exception 'Zero-amount transactions cannot be posted.'; end if;

  insert into journal_entries(client_id,transaction_id,entry_date,memo,status,created_by)
  values(p_client_id,v_transaction.id,v_transaction.posted_date,
    coalesce(v_transaction.merchant_name,'Bank transaction'),'draft',auth.uid())
  returning id into v_journal_entry_id;

  if v_amount>0 then
    insert into journal_lines(journal_entry_id,category_id,description,debit,credit) values
      (v_journal_entry_id,v_book_category.id,coalesce(v_transaction.merchant_name,'Categorized transaction'),v_abs_amount,0),
      (v_journal_entry_id,v_source_category.id,coalesce(v_transaction.merchant_name,'Connected account'),0,v_abs_amount);
  else
    insert into journal_lines(journal_entry_id,category_id,description,debit,credit) values
      (v_journal_entry_id,v_source_category.id,coalesce(v_transaction.merchant_name,'Connected account'),v_abs_amount,0),
      (v_journal_entry_id,v_book_category.id,coalesce(v_transaction.merchant_name,'Categorized transaction'),0,v_abs_amount);
  end if;

  perform post_journal_entry(v_journal_entry_id);
  return v_journal_entry_id;
end;
$$;

revoke all on function start_account_reconciliation(uuid,uuid,date,date,numeric,numeric,numeric) from public,anon;
grant execute on function start_account_reconciliation(uuid,uuid,date,date,numeric,numeric,numeric) to authenticated;
revoke all on function complete_account_reconciliation(uuid,uuid) from public,anon;
grant execute on function complete_account_reconciliation(uuid,uuid) to authenticated;
revoke all on function post_transaction_to_journal(uuid,uuid) from public,anon;
grant execute on function post_transaction_to_journal(uuid,uuid) to authenticated;

comment on function post_transaction_to_journal(uuid,uuid) is
  'Posts a confirmed transaction only outside completed reconciliation periods, serialized against reconciliation completion on the connected account.';
