-- ============================================================
-- ATOMIC BANK TRANSACTION -> JOURNAL POSTING
--
-- Hardens journal posting permissions and introduces one controlled,
-- atomic database operation for turning an eligible confirmed bank-feed
-- transaction into a balanced two-line journal entry.
--
-- No historical transactions are posted by this migration.
-- ============================================================

-- ------------------------------------------------------------
-- 1. HARDEN THE EXISTING POSTING BOUNDARY
--
-- Financial posting is a write operation. Read-only firm members must
-- never be able to post merely because they belong to the firm.
-- ------------------------------------------------------------

create or replace function post_journal_entry(p_journal_entry_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry journal_entries%rowtype;
  v_line_count integer;
  v_total_debit numeric(14,2);
  v_total_credit numeric(14,2);
  v_invalid_lines integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required.';
  end if;

  select *
    into v_entry
  from journal_entries
  where id = p_journal_entry_id
  for update;

  if not found then
    raise exception 'Journal entry not found.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = v_entry.client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to post journal entries for this client.';
  end if;

  if v_entry.status <> 'draft' then
    raise exception 'Only draft journal entries can be posted.';
  end if;

  select
    count(*),
    coalesce(sum(jl.debit), 0),
    coalesce(sum(jl.credit), 0)
  into
    v_line_count,
    v_total_debit,
    v_total_credit
  from journal_lines jl
  where jl.journal_entry_id = v_entry.id;

  if v_line_count < 2 then
    raise exception 'A journal entry requires at least two lines.';
  end if;

  if v_total_debit <= 0 or v_total_debit <> v_total_credit then
    raise exception 'Journal entry debits and credits must balance exactly.';
  end if;

  select count(*)
    into v_invalid_lines
  from journal_lines jl
  join categories c on c.id = jl.category_id
  where jl.journal_entry_id = v_entry.id
    and (
      c.client_id is distinct from v_entry.client_id
      or c.account_type is null
      or c.normal_balance is null
      or not c.is_active
      or not c.is_posting_account
    );

  if v_invalid_lines > 0 then
    raise exception 'Journal entry contains an invalid or unavailable chart-of-accounts entry.';
  end if;

  update journal_entries
  set
    status = 'posted',
    posted_by = auth.uid(),
    posted_at = now()
  where id = v_entry.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(),
    v_entry.client_id,
    'journal_entry_posted',
    jsonb_build_object(
      'journal_entry_id', v_entry.id,
      'transaction_id', v_entry.transaction_id,
      'total_debit', v_total_debit,
      'total_credit', v_total_credit
    )
  );

  return v_entry.id;
end;
$$;

revoke all on function post_journal_entry(uuid) from public;
revoke all on function post_journal_entry(uuid) from anon;
grant execute on function post_journal_entry(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. ATOMIC TRANSACTION POSTING
--
-- Plaid convention used by LedgerAI:
--   positive amount = money leaving / charge
--   negative amount = money entering / payment/refund
--
-- Therefore:
--   positive -> debit categorized account, credit source account
--   negative -> debit source account, credit categorized account
--
-- The mapped source account must be an asset/liability COA account and
-- the transaction category must be a classified client posting account.
-- ------------------------------------------------------------

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
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to post transactions for this client.';
  end if;

  select t.*
    into v_transaction
  from transactions t
  where t.id = p_transaction_id
    and t.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Transaction not found.';
  end if;

  if v_transaction.status <> 'confirmed' then
    raise exception 'Only confirmed transactions can be posted.';
  end if;

  if v_transaction.duplicate_of_transaction_id is not null then
    raise exception 'Confirmed duplicate transactions cannot be posted.';
  end if;

  if v_transaction.plaid_removed_at is not null then
    raise exception 'Provider-removed transactions cannot be posted.';
  end if;

  if v_transaction.ai_category_id is null then
    raise exception 'Transaction must have a bookkeeping category before posting.';
  end if;

  if exists (
    select 1
    from journal_entries je
    where je.transaction_id = v_transaction.id
      and je.reversal_of_journal_entry_id is null
  ) then
    raise exception 'Transaction already has a journal entry.';
  end if;

  select c.*
    into v_book_category
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

  select c.*
    into v_source_category
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  join categories c on c.id = a.coa_category_id
  where a.id = v_transaction.account_id
    and pi.client_id = p_client_id;

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

  if v_abs_amount <= 0 then
    raise exception 'Zero-amount transactions cannot be posted.';
  end if;

  insert into journal_entries (
    client_id,
    transaction_id,
    entry_date,
    memo,
    status,
    created_by
  )
  values (
    p_client_id,
    v_transaction.id,
    v_transaction.posted_date,
    coalesce(v_transaction.merchant_name, 'Bank transaction'),
    'draft',
    auth.uid()
  )
  returning id into v_journal_entry_id;

  if v_amount > 0 then
    insert into journal_lines (
      journal_entry_id,
      category_id,
      description,
      debit,
      credit
    )
    values
      (
        v_journal_entry_id,
        v_book_category.id,
        coalesce(v_transaction.merchant_name, 'Categorized transaction'),
        v_abs_amount,
        0
      ),
      (
        v_journal_entry_id,
        v_source_category.id,
        coalesce(v_transaction.merchant_name, 'Connected account'),
        0,
        v_abs_amount
      );
  else
    insert into journal_lines (
      journal_entry_id,
      category_id,
      description,
      debit,
      credit
    )
    values
      (
        v_journal_entry_id,
        v_source_category.id,
        coalesce(v_transaction.merchant_name, 'Connected account'),
        v_abs_amount,
        0
      ),
      (
        v_journal_entry_id,
        v_book_category.id,
        coalesce(v_transaction.merchant_name, 'Categorized transaction'),
        0,
        v_abs_amount
      );
  end if;

  perform post_journal_entry(v_journal_entry_id);

  return v_journal_entry_id;
end;
$$;

revoke all on function post_transaction_to_journal(uuid, uuid) from public;
revoke all on function post_transaction_to_journal(uuid, uuid) from anon;
grant execute on function post_transaction_to_journal(uuid, uuid) to authenticated;

comment on function post_transaction_to_journal(uuid, uuid) is
  'Atomically posts one confirmed, active, non-duplicate bank-feed transaction to a balanced two-line journal entry after validating user role, client scope, source-account mapping, and accounting-classified COA accounts.';
