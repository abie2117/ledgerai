-- ============================================================
-- MIGRATION 027
-- ACCOUNT RECONCILIATION CONTROL FOUNDATION
--
-- Turns the legacy reconciliation placeholder into an account-specific,
-- auditable accounting control. Completion is calculated from posted journal
-- movement, snapshots the included journals, and protects reconciled postings
-- from ordinary reversal until the reconciliation is formally reopened.
-- ============================================================

alter table reconciliations
  add column if not exists account_id uuid references accounts(id) on delete restrict,
  add column if not exists opening_statement_balance numeric(14,2),
  add column if not exists opening_book_balance numeric(14,2),
  add column if not exists closing_statement_balance numeric(14,2),
  add column if not exists calculated_book_movement numeric(14,2),
  add column if not exists calculated_book_closing_balance numeric(14,2),
  add column if not exists reconciliation_difference numeric(14,2),
  add column if not exists reopened_by uuid references auth.users(id),
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_reason text;

alter table reconciliations
  drop constraint if exists reconciliations_period_check;

alter table reconciliations
  add constraint reconciliations_period_check
  check (period_start <= period_end);

create index if not exists reconciliations_account_period_idx
  on reconciliations (account_id, period_start, period_end);

create table if not exists reconciliation_journal_entries (
  reconciliation_id uuid not null references reconciliations(id) on delete restrict,
  journal_entry_id uuid not null references journal_entries(id) on delete restrict,
  included_at timestamptz not null default now(),
  primary key (reconciliation_id, journal_entry_id)
);

create unique index if not exists reconciliation_journal_entry_completed_unique_idx
  on reconciliation_journal_entries (journal_entry_id);

alter table reconciliation_journal_entries enable row level security;

drop policy if exists "firm members can access reconciliations for their clients"
  on reconciliations;

create policy "firm members can view reconciliations"
  on reconciliations
  for select
  using (
    client_id in (
      select c.id
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where fu.user_id = auth.uid()
    )
  );

create policy "firm members can view reconciliation journals"
  on reconciliation_journal_entries
  for select
  using (
    reconciliation_id in (
      select r.id
      from reconciliations r
      join clients c on c.id = r.client_id
      join firm_users fu on fu.firm_id = c.firm_id
      where fu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on reconciliations from authenticated;
revoke insert, update, delete on reconciliation_journal_entries from authenticated;
revoke all on reconciliation_journal_entries from anon;

create or replace function protect_posted_account_coa_mapping()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.coa_category_id is distinct from old.coa_category_id
     and exists (
       select 1
       from transactions t
       join journal_entries je on je.transaction_id = t.id
       where t.account_id = old.id
         and je.reversal_of_journal_entry_id is null
         and je.status in ('draft', 'posted')
     ) then
    raise exception 'Connected account COA mapping cannot change while active transaction journals exist. Resolve the journal history first.';
  end if;

  return new;
end;
$$;

drop trigger if exists protect_posted_account_coa_mapping_trigger on accounts;

create trigger protect_posted_account_coa_mapping_trigger
before update of coa_category_id on accounts
for each row
execute function protect_posted_account_coa_mapping();

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
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'A valid reconciliation period is required.';
  end if;

  if p_opening_statement_balance is null
     or p_opening_book_balance is null
     or p_closing_statement_balance is null then
    raise exception 'Opening statement, opening book, and closing statement balances are required.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to reconcile accounts for this client.';
  end if;

  if not exists (
    select 1
    from accounts a
    join plaid_items pi on pi.id = a.plaid_item_id
    join categories coa on coa.id = a.coa_category_id
    where a.id = p_account_id
      and pi.client_id = p_client_id
      and coa.client_id = p_client_id
      and coa.account_type in ('asset', 'liability')
      and coa.normal_balance in ('debit', 'credit')
      and coa.is_active
      and coa.is_posting_account
  ) then
    raise exception 'Account must be mapped to an active client asset or liability posting account before reconciliation.';
  end if;

  if exists (
    select 1
    from reconciliations r
    where r.client_id = p_client_id
      and r.account_id = p_account_id
      and r.status in ('in_progress', 'completed', 'needs_attention')
      and daterange(r.period_start, r.period_end, '[]')
          && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'This account already has an overlapping active or completed reconciliation period.';
  end if;

  insert into reconciliations (
    client_id,
    account_id,
    period_start,
    period_end,
    status,
    opening_statement_balance,
    opening_book_balance,
    closing_statement_balance,
    summary
  )
  values (
    p_client_id,
    p_account_id,
    p_period_start,
    p_period_end,
    'in_progress',
    round(p_opening_statement_balance, 2),
    round(p_opening_book_balance, 2),
    round(p_closing_statement_balance, 2),
    '{}'::jsonb
  )
  returning id into v_reconciliation_id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'account_reconciliation_started',
    jsonb_build_object(
      'reconciliation_id', v_reconciliation_id,
      'account_id', p_account_id,
      'period_start', p_period_start,
      'period_end', p_period_end
    )
  );

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
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to complete reconciliations for this client.';
  end if;

  select r.*
    into v_reconciliation
  from reconciliations r
  where r.id = p_reconciliation_id
    and r.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Reconciliation not found.';
  end if;

  if v_reconciliation.status not in ('in_progress', 'needs_attention') then
    raise exception 'Only an in-progress or needs-attention reconciliation can be completed.';
  end if;

  if v_reconciliation.account_id is null
     or v_reconciliation.opening_statement_balance is null
     or v_reconciliation.opening_book_balance is null
     or v_reconciliation.closing_statement_balance is null then
    raise exception 'Reconciliation setup is incomplete.';
  end if;

  if round(v_reconciliation.opening_statement_balance, 2)
     <> round(v_reconciliation.opening_book_balance, 2) then
    raise exception 'Opening statement and opening book balances must agree before completion.';
  end if;

  select coa.*
    into v_source_category
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  join categories coa on coa.id = a.coa_category_id
  where a.id = v_reconciliation.account_id
    and pi.client_id = p_client_id;

  if not found
     or v_source_category.client_id is distinct from p_client_id
     or v_source_category.account_type not in ('asset', 'liability')
     or v_source_category.normal_balance not in ('debit', 'credit')
     or not v_source_category.is_active
     or not v_source_category.is_posting_account then
    raise exception 'Reconciled account mapping is no longer eligible for posting.';
  end if;

  -- Lock every posted original journal whose transaction belongs to this bank
  -- account and whose accounting date falls inside the statement period.
  perform je.id
  from journal_entries je
  join transactions t on t.id = je.transaction_id
  where je.client_id = p_client_id
    and t.client_id = p_client_id
    and t.account_id = v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null
    and je.status = 'posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  for update of je;

  if exists (
    select 1
    from journal_entries je
    join transactions t on t.id = je.transaction_id
    where je.client_id = p_client_id
      and t.client_id = p_client_id
      and t.account_id = v_reconciliation.account_id
      and je.reversal_of_journal_entry_id is null
      and je.status = 'draft'
      and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  ) then
    raise exception 'Active draft journals exist in the reconciliation period.';
  end if;

  select coalesce(
           sum(
             case
               when v_source_category.normal_balance = 'debit'
                 then jl.debit - jl.credit
               else jl.credit - jl.debit
             end
           ),
           0
         )::numeric(14,2)
    into v_movement
  from journal_entries je
  join transactions t on t.id = je.transaction_id
  join journal_lines jl
    on jl.journal_entry_id = je.id
   and jl.category_id = v_source_category.id
  where je.client_id = p_client_id
    and t.client_id = p_client_id
    and t.account_id = v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null
    and je.status = 'posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end;

  v_book_closing :=
    round(v_reconciliation.opening_book_balance + v_movement, 2);
  v_difference :=
    round(v_reconciliation.closing_statement_balance - v_book_closing, 2);

  if v_difference <> 0 then
    update reconciliations
    set
      status = 'needs_attention',
      calculated_book_movement = v_movement,
      calculated_book_closing_balance = v_book_closing,
      reconciliation_difference = v_difference,
      summary = jsonb_build_object(
        'book_movement', v_movement,
        'book_closing_balance', v_book_closing,
        'statement_closing_balance', closing_statement_balance,
        'difference', v_difference
      )
    where id = v_reconciliation.id;

    insert into audit_log (actor_id, client_id, action, detail)
    values (
      v_user_id,
      p_client_id,
      'account_reconciliation_needs_attention',
      jsonb_build_object(
        'reconciliation_id', v_reconciliation.id,
        'account_id', v_reconciliation.account_id,
        'book_movement', v_movement,
        'book_closing_balance', v_book_closing,
        'statement_closing_balance', v_reconciliation.closing_statement_balance,
        'difference', v_difference
      )
    );

    return query
      select v_reconciliation.id, v_movement, v_book_closing, v_difference, 0;
    return;
  end if;

  insert into reconciliation_journal_entries (
    reconciliation_id,
    journal_entry_id
  )
  select
    v_reconciliation.id,
    je.id
  from journal_entries je
  join transactions t on t.id = je.transaction_id
  where je.client_id = p_client_id
    and t.client_id = p_client_id
    and t.account_id = v_reconciliation.account_id
    and je.reversal_of_journal_entry_id is null
    and je.status = 'posted'
    and je.entry_date between v_reconciliation.period_start and v_reconciliation.period_end
  on conflict do nothing;

  get diagnostics v_count = row_count;

  update reconciliations
  set
    status = 'completed',
    calculated_book_movement = v_movement,
    calculated_book_closing_balance = v_book_closing,
    reconciliation_difference = 0,
    reconciled_by = v_user_id,
    reconciled_at = now(),
    summary = jsonb_build_object(
      'book_movement', v_movement,
      'book_closing_balance', v_book_closing,
      'statement_closing_balance', closing_statement_balance,
      'difference', 0,
      'included_journal_count', v_count
    )
  where id = v_reconciliation.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'account_reconciliation_completed',
    jsonb_build_object(
      'reconciliation_id', v_reconciliation.id,
      'account_id', v_reconciliation.account_id,
      'book_movement', v_movement,
      'book_closing_balance', v_book_closing,
      'difference', 0,
      'included_journal_count', v_count
    )
  );

  return query
    select v_reconciliation.id, v_movement, v_book_closing, 0::numeric, v_count;
end;
$$;

create or replace function update_account_reconciliation_balances(
  p_reconciliation_id uuid,
  p_client_id uuid,
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
  v_reconciliation reconciliations%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_opening_statement_balance is null
     or p_opening_book_balance is null
     or p_closing_statement_balance is null then
    raise exception 'Opening statement, opening book, and closing statement balances are required.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to update reconciliations for this client.';
  end if;

  select r.*
    into v_reconciliation
  from reconciliations r
  where r.id = p_reconciliation_id
    and r.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Reconciliation not found.';
  end if;

  if v_reconciliation.status not in ('in_progress', 'needs_attention') then
    raise exception 'Only an in-progress or needs-attention reconciliation can be updated.';
  end if;

  update reconciliations
  set
    status = 'in_progress',
    opening_statement_balance = round(p_opening_statement_balance, 2),
    opening_book_balance = round(p_opening_book_balance, 2),
    closing_statement_balance = round(p_closing_statement_balance, 2),
    calculated_book_movement = null,
    calculated_book_closing_balance = null,
    reconciliation_difference = null,
    summary = '{}'::jsonb
  where id = v_reconciliation.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'account_reconciliation_balances_updated',
    jsonb_build_object(
      'reconciliation_id', v_reconciliation.id,
      'account_id', v_reconciliation.account_id,
      'opening_statement_balance', round(p_opening_statement_balance, 2),
      'opening_book_balance', round(p_opening_book_balance, 2),
      'closing_statement_balance', round(p_closing_statement_balance, 2)
    )
  );

  return v_reconciliation.id;
end;
$$;

create or replace function reopen_account_reconciliation(
  p_reconciliation_id uuid,
  p_client_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_reconciliation reconciliations%rowtype;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required to reopen a reconciliation.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to reopen reconciliations for this client.';
  end if;

  select r.*
    into v_reconciliation
  from reconciliations r
  where r.id = p_reconciliation_id
    and r.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Reconciliation not found.';
  end if;

  if v_reconciliation.status <> 'completed' then
    raise exception 'Only a completed reconciliation can be reopened.';
  end if;

  delete from reconciliation_journal_entries
  where reconciliation_id = v_reconciliation.id;

  update reconciliations
  set
    status = 'in_progress',
    reconciled_by = null,
    reconciled_at = null,
    reopened_by = v_user_id,
    reopened_at = now(),
    reopen_reason = btrim(p_reason)
  where id = v_reconciliation.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'account_reconciliation_reopened',
    jsonb_build_object(
      'reconciliation_id', v_reconciliation.id,
      'account_id', v_reconciliation.account_id,
      'reason', btrim(p_reason)
    )
  );

  return v_reconciliation.id;
end;
$$;

-- Central reversal boundary: all correction/duplicate/provider workflows that
-- reverse a posting inherit completed-reconciliation protection.
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

  if not found then raise exception 'Journal entry not found.'; end if;
  if v_original.reversal_of_journal_entry_id is not null then
    raise exception 'A reversal entry cannot itself be reversed by this workflow.';
  end if;
  if v_original.status <> 'posted' then
    raise exception 'Only posted journal entries can be reversed.';
  end if;

  if exists (
    select 1
    from reconciliation_journal_entries rje
    join reconciliations r on r.id = rje.reconciliation_id
    where rje.journal_entry_id = v_original.id
      and r.client_id = p_client_id
      and r.status = 'completed'
  ) then
    raise exception 'Journal entry belongs to a completed reconciliation. Reopen that reconciliation before reversing the posting.';
  end if;

  if exists (
    select 1 from journal_entries je
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
  into v_line_count, v_total_debit, v_total_credit, v_invalid_lines
  from journal_lines jl
  left join categories c on c.id = jl.category_id
  where jl.journal_entry_id = v_original.id;

  if v_line_count < 2 or v_total_debit <= 0 or v_total_debit <> v_total_credit then
    raise exception 'Original journal entry is not a valid balanced posting.';
  end if;
  if v_invalid_lines > 0 then
    raise exception 'Original journal entry contains a category outside the selected client.';
  end if;

  insert into journal_entries (
    client_id, transaction_id, entry_date, memo, status,
    created_by, posted_by, posted_at, reversal_of_journal_entry_id
  )
  values (
    v_original.client_id, v_original.transaction_id, current_date,
    'Reversal: ' || coalesce(v_original.memo, 'Journal entry'),
    'posted', auth.uid(), auth.uid(), now(), v_original.id
  )
  returning id into v_reversal_id;

  insert into journal_lines (
    journal_entry_id, category_id, description, debit, credit
  )
  select
    v_reversal_id, jl.category_id,
    'Reversal: ' || coalesce(jl.description, 'Journal line'),
    jl.credit, jl.debit
  from journal_lines jl
  where jl.journal_entry_id = v_original.id;

  update journal_entries
  set status = 'reversed', reversed_by = auth.uid(), reversed_at = now()
  where id = v_original.id and status = 'posted';

  if not found then
    raise exception 'Journal entry changed before reversal could complete.';
  end if;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(), v_original.client_id, 'journal_entry_reversed',
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

revoke all on function start_account_reconciliation(uuid, uuid, date, date, numeric, numeric, numeric) from public;
revoke all on function start_account_reconciliation(uuid, uuid, date, date, numeric, numeric, numeric) from anon;
grant execute on function start_account_reconciliation(uuid, uuid, date, date, numeric, numeric, numeric) to authenticated;

revoke all on function complete_account_reconciliation(uuid, uuid) from public;
revoke all on function complete_account_reconciliation(uuid, uuid) from anon;
grant execute on function complete_account_reconciliation(uuid, uuid) to authenticated;

revoke all on function update_account_reconciliation_balances(uuid, uuid, numeric, numeric, numeric) from public;
revoke all on function update_account_reconciliation_balances(uuid, uuid, numeric, numeric, numeric) from anon;
grant execute on function update_account_reconciliation_balances(uuid, uuid, numeric, numeric, numeric) to authenticated;

revoke all on function reopen_account_reconciliation(uuid, uuid, text) from public;
revoke all on function reopen_account_reconciliation(uuid, uuid, text) from anon;
grant execute on function reopen_account_reconciliation(uuid, uuid, text) to authenticated;

revoke all on function reverse_journal_entry(uuid, uuid) from public;
revoke all on function reverse_journal_entry(uuid, uuid) from anon;
grant execute on function reverse_journal_entry(uuid, uuid) to authenticated;

comment on table reconciliation_journal_entries is
  'Immutable snapshot membership for journals included in a completed account reconciliation. Removed only by the controlled reopen workflow.';

comment on function complete_account_reconciliation(uuid, uuid) is
  'Completes an account reconciliation only when opening balances agree and statement closing balance exactly equals calculated book closing balance from posted journal movement.';
