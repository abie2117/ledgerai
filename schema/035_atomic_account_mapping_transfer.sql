-- MIGRATION 035: controlled succession of an existing bank ledger mapping.
-- No source activation, category creation, or transaction mutation occurs here.
create or replace function transfer_account_coa_mapping(
  p_client_id uuid,
  p_from_account_id uuid,
  p_to_account_id uuid,
  p_category_id uuid
)
returns table (account_id uuid, coa_category_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_from accounts%rowtype;
  v_to accounts%rowtype;
  v_source plaid_items%rowtype;
  v_retained plaid_items%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required.'; end if;
  if p_client_id is null or p_from_account_id is null or p_to_account_id is null
     or p_category_id is null or p_from_account_id = p_to_account_id then
    raise exception 'Client, distinct source and destination accounts, and expected ledger account are required.';
  end if;
  if not exists (
    select 1 from clients c join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then raise exception 'Owner, admin, or bookkeeper access is required to transfer account mappings.'; end if;

  -- Match source-resolution lock order, then ordinary setup/reconciliation.
  -- Lock provider rows before accounts so statuses cannot change mid-transfer.
  perform pi.id from plaid_items pi
  where pi.id in (
    select a.plaid_item_id from accounts a
    where a.id in (p_from_account_id, p_to_account_id)
  ) and pi.client_id = p_client_id
  order by pi.id for update;

  perform a.id from accounts a join plaid_items pi on pi.id = a.plaid_item_id
  where a.id in (p_from_account_id, p_to_account_id) and pi.client_id = p_client_id
  order by a.id for update of a;

  select a.* into v_from from accounts a join plaid_items pi on pi.id = a.plaid_item_id
  where a.id = p_from_account_id and pi.client_id = p_client_id;
  if not found then raise exception 'Source account not found for this client.'; end if;
  select a.* into v_to from accounts a join plaid_items pi on pi.id = a.plaid_item_id
  where a.id = p_to_account_id and pi.client_id = p_client_id;
  if not found then raise exception 'Destination account not found for this client.'; end if;

  select pi.* into v_source from plaid_items pi
  where pi.id = v_from.plaid_item_id and pi.client_id = p_client_id;
  select pi.* into v_retained from plaid_items pi
  where pi.id = v_to.plaid_item_id and pi.client_id = p_client_id;
  if v_source.financial_source_status is distinct from 'superseded'
     or v_source.superseded_by_plaid_item_id is distinct from v_retained.id then
    raise exception 'Source must already be superseded by the destination financial source.';
  end if;
  if v_retained.status is distinct from 'active'
     or v_retained.financial_source_status is distinct from 'active' then
    raise exception 'Destination must be provider-active and financially active.';
  end if;
  if v_from.coa_category_id is distinct from p_category_id then
    raise exception 'Source mapping changed. Reload accounting setup before transferring.';
  end if;
  if v_to.coa_category_id is not null then
    raise exception 'Destination must be unmapped.';
  end if;

  perform c.id from categories c where c.id = p_category_id
    and c.client_id = p_client_id and c.account_type in ('asset', 'liability')
    and c.normal_balance in ('debit', 'credit') and c.is_active and c.is_posting_account
  for update;
  if not found then raise exception 'Ledger account is not eligible for this client.'; end if;

  if exists (
    select 1 from transactions t join journal_entries je on je.transaction_id = t.id
    where t.account_id in (p_from_account_id, p_to_account_id)
      and je.reversal_of_journal_entry_id is null and je.status in ('draft', 'posted')
  ) then raise exception 'Both accounts must have zero active journals before a mapping transfer.'; end if;
  if exists (
    select 1 from reconciliations r
    where r.account_id in (p_from_account_id, p_to_account_id)
  ) then raise exception 'Both accounts must have zero reconciliations before a mapping transfer.'; end if;

  -- Release first to preserve the immediate unique index; both updates and
  -- the audit record commit together. Existing protection triggers still run.
  update accounts set coa_category_id = null where id = v_from.id;
  update accounts set coa_category_id = p_category_id where id = v_to.id;
  insert into audit_log (actor_id, client_id, action, detail)
  values (v_user_id, p_client_id, 'connected_account_mapping_transferred',
    jsonb_build_object('from_account_id', v_from.id, 'to_account_id', v_to.id,
      'from_plaid_item_id', v_source.id, 'to_plaid_item_id', v_retained.id,
      'coa_category_id', p_category_id,
      'previous_from_coa_category_id', v_from.coa_category_id,
      'previous_to_coa_category_id', v_to.coa_category_id,
      'new_from_coa_category_id', null, 'new_to_coa_category_id', p_category_id));
  return query select v_to.id, p_category_id;
end;
$$;

revoke all on function transfer_account_coa_mapping(uuid,uuid,uuid,uuid) from public, anon;
grant execute on function transfer_account_coa_mapping(uuid,uuid,uuid,uuid) to authenticated;
comment on function transfer_account_coa_mapping(uuid,uuid,uuid,uuid) is
  'Transfers an expected ledger mapping from a superseded source to its active successor, with tenant/role checks, empty accounting-history checks, existing triggers, atomic updates, and audit history.';

-- Preserve source eligibility while restoring posting serialization.
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
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1 from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to post transactions for this client.';
  end if;

  select t.* into v_transaction
  from transactions t
  where t.id = p_transaction_id
    and t.client_id = p_client_id
  for update;

  if not found then raise exception 'Transaction not found.'; end if;
  if v_transaction.status <> 'confirmed' then raise exception 'Only confirmed transactions can be posted.'; end if;
  if v_transaction.duplicate_of_transaction_id is not null then raise exception 'Confirmed duplicate transactions cannot be posted.'; end if;
  if v_transaction.plaid_removed_at is not null then raise exception 'Provider-removed transactions cannot be posted.'; end if;
  if v_transaction.ai_category_id is null then raise exception 'Transaction must have a bookkeeping category before posting.'; end if;

  -- Restore migration 029's account serialization and closed-period guard.
  -- Migration 034's source checks below remain authoritative.
  perform a.id from accounts a join plaid_items pi on pi.id = a.plaid_item_id
  where a.id = v_transaction.account_id and pi.client_id = p_client_id
  for update of a;
  if not found then raise exception 'Connected account does not belong to the selected client.'; end if;
  if exists (
    select 1 from reconciliations r where r.account_id = v_transaction.account_id
      and r.client_id = p_client_id and r.status = 'completed'
      and v_transaction.posted_date between r.period_start and r.period_end
  ) then
    raise exception 'Transaction falls inside a completed reconciliation period. Reopen that reconciliation before posting.';
  end if;

  if exists (
    select 1
    from accounts a
    join plaid_items pi on pi.id = a.plaid_item_id
    where a.id = v_transaction.account_id
      and pi.client_id = p_client_id
      and (pi.financial_source_status <> 'active' or pi.status <> 'active')
  ) then
    raise exception 'Transactions from a non-active or provider-inactive Plaid financial source cannot be posted.';
  end if;

  if not exists (
    select 1
    from accounts a
    join plaid_items pi on pi.id = a.plaid_item_id
    where a.id = v_transaction.account_id
      and pi.client_id = p_client_id
      and pi.financial_source_status = 'active'
      and pi.status = 'active'
  ) then
    raise exception 'Transaction is not attached to an active Plaid financial source.';
  end if;

  if exists (
    select 1 from journal_entries je
    where je.transaction_id = v_transaction.id
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  ) then
    raise exception 'Transaction already has an active journal entry.';
  end if;

  select c.* into v_book_category
  from categories c
  where c.id = v_transaction.ai_category_id;

  if not found
     or v_book_category.client_id is distinct from p_client_id
     or v_book_category.account_type is null
     or v_book_category.normal_balance is null
     or not v_book_category.is_active
     or not v_book_category.is_posting_account then
    raise exception 'Transaction category is not an eligible client posting account.';
  end if;

  select c.* into v_source_category
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  join categories c on c.id = a.coa_category_id
  where a.id = v_transaction.account_id
    and pi.client_id = p_client_id
    and pi.financial_source_status = 'active'
      and pi.status = 'active';

  if not found
     or v_source_category.client_id is distinct from p_client_id
     or v_source_category.account_type not in ('asset', 'liability')
     or v_source_category.normal_balance is null
     or not v_source_category.is_active
     or not v_source_category.is_posting_account then
    raise exception 'Connected account is not mapped to an eligible client asset or liability posting account.';
  end if;

  if v_source_category.id = v_book_category.id then
    raise exception 'Source and categorized accounts must be different.';
  end if;

  v_amount := v_transaction.amount;
  v_abs_amount := abs(v_amount);
  if v_abs_amount <= 0 then raise exception 'Zero-amount transactions cannot be posted.'; end if;

  insert into journal_entries (client_id, transaction_id, entry_date, memo, status, created_by)
  values (p_client_id, v_transaction.id, v_transaction.posted_date,
          coalesce(v_transaction.merchant_name, 'Bank transaction'), 'draft', auth.uid())
  returning id into v_journal_entry_id;

  if v_amount > 0 then
    insert into journal_lines (journal_entry_id, category_id, description, debit, credit)
    values
      (v_journal_entry_id, v_book_category.id, coalesce(v_transaction.merchant_name, 'Categorized transaction'), v_abs_amount, 0),
      (v_journal_entry_id, v_source_category.id, coalesce(v_transaction.merchant_name, 'Connected account'), 0, v_abs_amount);
  else
    insert into journal_lines (journal_entry_id, category_id, description, debit, credit)
    values
      (v_journal_entry_id, v_source_category.id, coalesce(v_transaction.merchant_name, 'Connected account'), v_abs_amount, 0),
      (v_journal_entry_id, v_book_category.id, coalesce(v_transaction.merchant_name, 'Categorized transaction'), 0, v_abs_amount);
  end if;

  perform post_journal_entry(v_journal_entry_id);
  return v_journal_entry_id;
end;
$$;

revoke all on function post_transaction_to_journal(uuid, uuid) from public;
revoke all on function post_transaction_to_journal(uuid, uuid) from anon;
grant execute on function post_transaction_to_journal(uuid, uuid) to authenticated;

