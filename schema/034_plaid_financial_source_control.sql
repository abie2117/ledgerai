-- ============================================================
-- MIGRATION 034
-- PLAID FINANCIAL SOURCE CONTROL
--
-- Adds an explicit financial-source lifecycle for connected Plaid Items.
-- Existing Items remain financially active. New application connections can be staged as pending_review. Supersession is always an
-- explicit accounting decision; this migration does not guess a canonical
-- source, delete transactions, or rewrite historical financial data.
-- ============================================================

alter table plaid_items
  add column if not exists financial_source_status text
    not null default 'active';

alter table plaid_items
  drop constraint if exists plaid_items_financial_source_status_check;

alter table plaid_items
  add constraint plaid_items_financial_source_status_check
  check (financial_source_status in ('pending_review', 'active', 'superseded'));

alter table plaid_items
  add column if not exists superseded_by_plaid_item_id uuid
    references plaid_items(id);

alter table plaid_items
  add column if not exists superseded_at timestamptz;

alter table plaid_items
  add column if not exists superseded_by uuid
    references auth.users(id);

alter table plaid_items
  drop constraint if exists plaid_items_financial_source_supersession_metadata_check;

alter table plaid_items
  add constraint plaid_items_financial_source_supersession_metadata_check
  check (
    (
      financial_source_status in ('pending_review', 'active')
      and superseded_by_plaid_item_id is null
      and superseded_at is null
      and superseded_by is null
    )
    or
    (
      financial_source_status = 'superseded'
      and superseded_by_plaid_item_id is not null
      and superseded_by_plaid_item_id <> id
      and superseded_at is not null
      and superseded_by is not null
    )
  );

create index if not exists plaid_items_client_financial_source_status_idx
  on plaid_items (client_id, financial_source_status);

-- Explicit accounting action. This does not delete or mutate transactions.
create or replace function supersede_plaid_financial_source(
  p_client_id uuid,
  p_plaid_item_id uuid,
  p_retained_plaid_item_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source plaid_items%rowtype;
  v_retained plaid_items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to manage financial sources for this client.';
  end if;

  if p_plaid_item_id = p_retained_plaid_item_id then
    raise exception 'A Plaid Item cannot supersede itself.';
  end if;

  -- Deterministic lock order prevents concurrent opposite supersession.
  perform 1
  from plaid_items pi
  where pi.id in (p_plaid_item_id, p_retained_plaid_item_id)
  order by pi.id
  for update;

  select * into v_source
  from plaid_items
  where id = p_plaid_item_id
    and client_id = p_client_id;

  if not found then
    raise exception 'Plaid financial source not found.';
  end if;

  select * into v_retained
  from plaid_items
  where id = p_retained_plaid_item_id
    and client_id = p_client_id;

  if not found then
    raise exception 'Retained Plaid financial source not found.';
  end if;

  if v_retained.financial_source_status <> 'active' or v_retained.status <> 'active' then
    raise exception 'Retained Plaid financial source must be financially active and provider-active.';
  end if;

  if v_source.financial_source_status = 'superseded' then
    if v_source.superseded_by_plaid_item_id = p_retained_plaid_item_id then
      return v_source.id;
    end if;

    raise exception 'Plaid financial source is already superseded by a different source.';
  end if;

  -- Do not silently remove a source that already participates in an active
  -- ledger. Those entries must be resolved explicitly first.
  if exists (
    select 1
    from transactions t
    join accounts a on a.id = t.account_id
    join journal_entries je on je.transaction_id = t.id
    where a.plaid_item_id = p_plaid_item_id
      and t.client_id = p_client_id
      and je.client_id = p_client_id
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  ) then
    raise exception 'Plaid financial source has active journal entries and cannot be superseded until they are resolved.';
  end if;

  update plaid_items
  set financial_source_status = 'superseded',
      superseded_by_plaid_item_id = p_retained_plaid_item_id,
      superseded_at = now(),
      superseded_by = auth.uid()
  where id = p_plaid_item_id
    and client_id = p_client_id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(),
    p_client_id,
    'plaid_financial_source_superseded',
    jsonb_build_object(
      'plaid_item_id', p_plaid_item_id,
      'retained_plaid_item_id', p_retained_plaid_item_id
    )
  );

  return p_plaid_item_id;
end;
$$;

revoke all on function supersede_plaid_financial_source(uuid, uuid, uuid) from public;
revoke all on function supersede_plaid_financial_source(uuid, uuid, uuid) from anon;
grant execute on function supersede_plaid_financial_source(uuid, uuid, uuid) to authenticated;

-- Harden the final posting boundary. UI checks remain advisory; the database
-- is authoritative.
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

comment on column plaid_items.financial_source_status is
  'Controls financial eligibility for this Plaid Item. pending_review is non-postable, active is eligible only while the provider Item is also active, and superseded retains history without feeding new ledger postings.';

comment on function supersede_plaid_financial_source(uuid, uuid, uuid) is
  'Explicitly marks one client Plaid Item as superseded by another active Item after ensuring the source has no active journal entries.';
