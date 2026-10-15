-- ============================================================
-- MIGRATION 021
-- ATOMIC POSTED-TRANSACTION HUMAN MUTATIONS
--
-- Makes the journal lifecycle coherent for human bookkeeping changes:
--   posted -> reversal -> mutation -> eligible for controlled repost.
--
-- Provider-originated Plaid modifications/removals are intentionally
-- excluded; they require a separate pending-provider-change workflow.
-- ============================================================

-- ------------------------------------------------------------
-- 1. REVERSAL MUST NOT DEPEND ON CURRENT COA ACTIVATION
--
-- A historical posted entry was valid when posted. Its reversal must remain
-- possible if one of its COA accounts was later deactivated. We still require
-- every historical line to reference a category owned by the same client and
-- require the original entry to be exactly balanced.
-- ------------------------------------------------------------

create or replace function reverse_journal_entry(
  p_journal_entry_id uuid,
  p_client_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original journal_entries%rowtype;
  v_reversal_id uuid;
  v_line_count integer;
  v_total_debit numeric(14,2);
  v_total_credit numeric(14,2);
  v_invalid_lines integer;
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
    raise exception 'User is not authorized to reverse journal entries for this client.';
  end if;

  select je.*
    into v_original
  from journal_entries je
  where je.id = p_journal_entry_id
    and je.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Journal entry not found.';
  end if;

  if v_original.reversal_of_journal_entry_id is not null then
    raise exception 'A reversal entry cannot itself be reversed by this workflow.';
  end if;

  if v_original.status <> 'posted' then
    raise exception 'Only posted journal entries can be reversed.';
  end if;

  if exists (
    select 1
    from journal_entries je
    where je.reversal_of_journal_entry_id = v_original.id
  ) then
    raise exception 'Journal entry has already been reversed.';
  end if;

  select
    count(*),
    coalesce(sum(jl.debit), 0),
    coalesce(sum(jl.credit), 0),
    count(*) filter (
      where c.id is null
         or c.client_id is distinct from v_original.client_id
    )
  into
    v_line_count,
    v_total_debit,
    v_total_credit,
    v_invalid_lines
  from journal_lines jl
  left join categories c on c.id = jl.category_id
  where jl.journal_entry_id = v_original.id;

  if v_line_count < 2
     or v_total_debit <= 0
     or v_total_debit <> v_total_credit then
    raise exception 'Original journal entry is not a valid balanced posting.';
  end if;

  if v_invalid_lines > 0 then
    raise exception 'Original journal entry contains a category outside the selected client.';
  end if;

  insert into journal_entries (
    client_id,
    transaction_id,
    entry_date,
    memo,
    status,
    created_by,
    posted_by,
    posted_at,
    reversal_of_journal_entry_id
  )
  values (
    v_original.client_id,
    v_original.transaction_id,
    current_date,
    'Reversal: ' || coalesce(v_original.memo, 'Journal entry'),
    'posted',
    auth.uid(),
    auth.uid(),
    now(),
    v_original.id
  )
  returning id into v_reversal_id;

  insert into journal_lines (
    journal_entry_id,
    category_id,
    description,
    debit,
    credit
  )
  select
    v_reversal_id,
    jl.category_id,
    'Reversal: ' || coalesce(jl.description, 'Journal line'),
    jl.credit,
    jl.debit
  from journal_lines jl
  where jl.journal_entry_id = v_original.id;

  update journal_entries
  set
    status = 'reversed',
    reversed_by = auth.uid(),
    reversed_at = now()
  where id = v_original.id
    and status = 'posted';

  if not found then
    raise exception 'Journal entry changed before reversal could complete.';
  end if;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(),
    v_original.client_id,
    'journal_entry_reversed',
    jsonb_build_object(
      'journal_entry_id', v_original.id,
      'reversal_journal_entry_id', v_reversal_id,
      'transaction_id', v_original.transaction_id,
      'total_debit', v_total_debit,
      'total_credit', v_total_credit
    )
  );

  return v_reversal_id;
end;
$$;

revoke all on function reverse_journal_entry(uuid, uuid) from public;
revoke all on function reverse_journal_entry(uuid, uuid) from anon;
grant execute on function reverse_journal_entry(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. REPOST ELIGIBILITY
--
-- Historical reversed originals must not block a corrected transaction from
-- being posted again. Only an active draft/posted original blocks posting.
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

-- ------------------------------------------------------------
-- 3. ATOMIC CATEGORY CORRECTION
--
-- If the transaction has an active posted journal, reverse it first inside
-- this same database transaction. Active drafts are rejected because they
-- have not entered the immutable posted ledger and should be handled
-- explicitly rather than silently discarded.
-- ------------------------------------------------------------

create or replace function correct_transaction_category(
  p_transaction_id uuid,
  p_client_id uuid,
  p_to_category_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction transactions%rowtype;
  v_category categories%rowtype;
  v_active_journal journal_entries%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required.'; end if;

  if not exists (
    select 1 from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to correct transactions for this client.';
  end if;

  select t.* into v_transaction
  from transactions t
  where t.id = p_transaction_id and t.client_id = p_client_id
  for update;

  if not found then raise exception 'Transaction not found.'; end if;
  if v_transaction.plaid_removed_at is not null then raise exception 'Provider-removed transactions cannot be corrected through this workflow.'; end if;
  if v_transaction.duplicate_of_transaction_id is not null then raise exception 'Confirmed duplicate transactions cannot be corrected.'; end if;

  select c.* into v_category
  from categories c
  where c.id = p_to_category_id
    and (c.client_id = p_client_id or c.client_id is null);

  if not found then raise exception 'Selected category is not available for this client.'; end if;

  if v_transaction.ai_category_id = p_to_category_id then
    return p_transaction_id;
  end if;

  select je.* into v_active_journal
  from journal_entries je
  where je.transaction_id = p_transaction_id
    and je.reversal_of_journal_entry_id is null
    and je.status in ('draft', 'posted')
  for update;

  if found and v_active_journal.status = 'draft' then
    raise exception 'Transaction has an active draft journal entry that must be resolved before correction.';
  end if;

  if found and v_active_journal.status = 'posted' then
    perform reverse_journal_entry(v_active_journal.id, p_client_id);
  end if;

  insert into category_corrections (
    transaction_id, client_id, from_category_id, to_category_id, corrected_by
  ) values (
    p_transaction_id, p_client_id, v_transaction.ai_category_id, p_to_category_id, auth.uid()
  );

  update transactions
  set ai_category_id = p_to_category_id,
      ai_confidence = 1,
      categorization_source = 'manual',
      category = v_category.name,
      status = 'confirmed',
      updated_at = now()
  where id = p_transaction_id and client_id = p_client_id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(), p_client_id, 'transaction_category_corrected',
    jsonb_build_object(
      'transaction_id', p_transaction_id,
      'from_category_id', v_transaction.ai_category_id,
      'to_category_id', p_to_category_id,
      'journal_reversed', (v_active_journal.id is not null and v_active_journal.status = 'posted')
    )
  );

  return p_transaction_id;
end;
$$;

revoke all on function correct_transaction_category(uuid, uuid, uuid) from public;
revoke all on function correct_transaction_category(uuid, uuid, uuid) from anon;
grant execute on function correct_transaction_category(uuid, uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. ATOMIC DUPLICATE RESOLUTION WITH POSTED-JOURNAL REVERSAL
-- ------------------------------------------------------------

create or replace function resolve_duplicate_candidate(
  p_candidate_id uuid,
  p_client_id uuid,
  p_duplicate_transaction_id uuid
)
returns table (
  candidate_id uuid,
  duplicate_transaction_id uuid,
  retained_transaction_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_candidate duplicate_candidates%rowtype;
  v_retained_transaction_id uuid;
  v_pair_count integer;
  v_active_journal journal_entries%rowtype;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;

  if not exists (
    select 1 from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to resolve duplicates for this client';
  end if;

  select * into v_candidate
  from duplicate_candidates
  where id = p_candidate_id and client_id = p_client_id
  for update;

  if not found then raise exception 'Duplicate candidate not found'; end if;
  if v_candidate.status <> 'open' then raise exception 'Duplicate candidate is no longer open'; end if;

  if p_duplicate_transaction_id = v_candidate.transaction_a_id then
    v_retained_transaction_id := v_candidate.transaction_b_id;
  elsif p_duplicate_transaction_id = v_candidate.transaction_b_id then
    v_retained_transaction_id := v_candidate.transaction_a_id;
  else
    raise exception 'Selected transaction is not part of this duplicate candidate';
  end if;

  select count(*) into v_pair_count
  from transactions
  where client_id = p_client_id
    and id in (v_candidate.transaction_a_id, v_candidate.transaction_b_id);

  if v_pair_count <> 2 then raise exception 'Duplicate candidate transactions do not belong to the selected client'; end if;

  if exists (
    select 1 from transactions
    where id = p_duplicate_transaction_id and duplicate_of_transaction_id is not null
  ) then raise exception 'Selected transaction is already resolved as a duplicate'; end if;

  if exists (
    select 1 from transactions
    where id = v_retained_transaction_id and duplicate_of_transaction_id is not null
  ) then raise exception 'The transaction selected to retain is already resolved as a duplicate'; end if;

  select je.* into v_active_journal
  from journal_entries je
  where je.transaction_id = p_duplicate_transaction_id
    and je.reversal_of_journal_entry_id is null
    and je.status in ('draft', 'posted')
  for update;

  if found and v_active_journal.status = 'draft' then
    raise exception 'Selected duplicate has an active draft journal entry that must be resolved first.';
  end if;

  if found and v_active_journal.status = 'posted' then
    perform reverse_journal_entry(v_active_journal.id, p_client_id);
  end if;

  update transactions
  set duplicate_of_transaction_id = v_retained_transaction_id,
      duplicate_resolved_at = now(),
      duplicate_resolved_by = v_user_id,
      updated_at = now()
  where id = p_duplicate_transaction_id and client_id = p_client_id;

  update duplicate_candidates
  set status = 'resolved', resolved_at = now(), resolved_by = v_user_id
  where id = p_candidate_id and client_id = p_client_id and status = 'open';

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id, p_client_id, 'duplicate_confirmed',
    jsonb_build_object(
      'candidate_id', p_candidate_id,
      'duplicate_transaction_id', p_duplicate_transaction_id,
      'retained_transaction_id', v_retained_transaction_id,
      'journal_reversed', (v_active_journal.id is not null and v_active_journal.status = 'posted')
    )
  );

  return query select p_candidate_id, p_duplicate_transaction_id, v_retained_transaction_id;
end;
$$;

revoke all on function resolve_duplicate_candidate(uuid, uuid, uuid) from public;
revoke all on function resolve_duplicate_candidate(uuid, uuid, uuid) from anon;
grant execute on function resolve_duplicate_candidate(uuid, uuid, uuid) to authenticated;

comment on function correct_transaction_category(uuid, uuid, uuid) is
  'Atomically reverses an active posted journal when necessary and applies a human category correction, leaving the corrected transaction eligible for controlled reposting.';

comment on function resolve_duplicate_candidate(uuid, uuid, uuid) is
  'Atomically reverses an active posted journal when necessary before excluding a confirmed duplicate; restricted to owner/admin/bookkeeper roles.';

comment on function reverse_journal_entry(uuid, uuid) is
  'Atomically reverses a posted original journal using its historical balanced lines without requiring those historical COA accounts to remain active.';
