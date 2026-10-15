-- ============================================================
-- BALANCED JOURNAL FOUNDATION
--
-- Introduces an auditable double-entry ledger without posting any existing
-- bank transactions. Journal entries begin as drafts and can only become
-- posted through the controlled posting function below.
-- ============================================================

create table journal_entries (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete restrict,
  entry_date date not null,
  memo text,
  status text not null default 'draft'
    check (status in ('draft', 'posted', 'reversed')),
  created_by uuid not null references auth.users(id),
  posted_by uuid references auth.users(id),
  posted_at timestamptz,
  reversed_by uuid references auth.users(id),
  reversed_at timestamptz,
  reversal_of_journal_entry_id uuid references journal_entries(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (
    (status = 'draft' and posted_by is null and posted_at is null)
    or
    (status in ('posted', 'reversed') and posted_by is not null and posted_at is not null)
  ),
  check (
    (status <> 'reversed' and reversed_by is null and reversed_at is null)
    or
    (status = 'reversed' and reversed_by is not null and reversed_at is not null)
  ),
  check (reversal_of_journal_entry_id is null or reversal_of_journal_entry_id <> id)
);

create unique index journal_entries_transaction_unique_idx
  on journal_entries (transaction_id)
  where transaction_id is not null and reversal_of_journal_entry_id is null;

create index journal_entries_client_date_idx
  on journal_entries (client_id, entry_date);

create table journal_lines (
  id uuid primary key default uuid_generate_v4(),
  journal_entry_id uuid not null references journal_entries(id) on delete cascade,
  category_id uuid not null references categories(id) on delete restrict,
  description text,
  debit numeric(14,2) not null default 0 check (debit >= 0),
  credit numeric(14,2) not null default 0 check (credit >= 0),
  created_at timestamptz not null default now(),
  check (
    (debit > 0 and credit = 0)
    or
    (credit > 0 and debit = 0)
  )
);

create index journal_lines_entry_idx
  on journal_lines (journal_entry_id);

create index journal_lines_category_idx
  on journal_lines (category_id);

alter table journal_entries enable row level security;
alter table journal_lines enable row level security;

create policy "firm members can view journal entries" on journal_entries
  for select using (
    client_id in (
      select id from clients
      where firm_id in (select firm_id from my_firms)
    )
  );

create policy "firm members can view journal lines" on journal_lines
  for select using (
    journal_entry_id in (
      select id from journal_entries
      where client_id in (
        select id from clients
        where firm_id in (select firm_id from my_firms)
      )
    )
  );

-- ------------------------------------------------------------
-- CONTROLLED POSTING
--
-- Direct client writes are intentionally not granted. Posting validates
-- tenant ownership, account eligibility, at least two lines, and exact
-- debit/credit equality before changing the entry to posted.
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
  ) then
    raise exception 'Journal entry is not available to this user.';
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

comment on table journal_entries is
  'Auditable double-entry journal headers. Existing bank transactions are not posted automatically by this migration.';

comment on table journal_lines is
  'Debit and credit lines belonging to a journal entry. Posted entries must balance exactly.';

comment on function post_journal_entry(uuid) is
  'Controlled posting boundary: verifies user/client access, balanced lines, and eligible client-specific posting accounts before posting and auditing the journal entry.';
