-- ============================================================
-- MIGRATION 019
-- CONTROLLED JOURNAL REVERSAL LIFECYCLE
--
-- A posted journal is never edited or deleted. Reversal creates a new,
-- balanced journal entry with debit/credit directions inverted, links it
-- to the original, marks the original as reversed, and records an audit
-- event atomically.
--
-- Reversing releases the source transaction for a later controlled
-- correction and repost. This migration does not modify the transaction.
-- ============================================================

-- One transaction may have historical reversed originals, but only one
-- current original journal may be draft or posted at a time.
drop index if exists journal_entries_transaction_unique_idx;

create unique index journal_entries_active_transaction_unique_idx
  on journal_entries (transaction_id)
  where transaction_id is not null
    and reversal_of_journal_entry_id is null
    and status in ('draft', 'posted');

-- An original journal may have at most one reversal entry.
create unique index journal_entries_single_reversal_idx
  on journal_entries (reversal_of_journal_entry_id)
  where reversal_of_journal_entry_id is not null;

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
    coalesce(sum(jl.credit), 0)
  into
    v_line_count,
    v_total_debit,
    v_total_credit
  from journal_lines jl
  where jl.journal_entry_id = v_original.id;

  if v_line_count < 2
     or v_total_debit <= 0
     or v_total_debit <> v_total_credit then
    raise exception 'Original journal entry is not a valid balanced posting.';
  end if;

  insert into journal_entries (
    client_id,
    transaction_id,
    entry_date,
    memo,
    status,
    created_by,
    reversal_of_journal_entry_id
  )
  values (
    v_original.client_id,
    v_original.transaction_id,
    current_date,
    'Reversal: ' || coalesce(v_original.memo, 'Journal entry'),
    'draft',
    auth.uid(),
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

  perform post_journal_entry(v_reversal_id);

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

  insert into audit_log (
    actor_id,
    client_id,
    action,
    detail
  )
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

comment on function reverse_journal_entry(uuid, uuid) is
  'Atomically reverses one posted original journal for an authorized owner/admin/bookkeeper by posting an equal-and-opposite linked entry, marking the original reversed, and auditing the event.';

comment on index journal_entries_active_transaction_unique_idx is
  'Allows historical reversed journals while enforcing at most one active original draft/posted journal per transaction.';

comment on index journal_entries_single_reversal_idx is
  'Prevents more than one reversal journal from referencing the same original journal entry.';
