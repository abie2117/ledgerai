-- ============================================================
-- MIGRATION 028
-- VENDOR IDENTITY + RECURRING EVIDENCE FOUNDATION
-- ============================================================
-- This migration creates bookkeeping evidence/control records only.
-- It does not confirm transactions, create bills, post journals,
-- change categories, or affect financial reporting.

create table if not exists vendors (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  display_name text not null,
  normalized_name text not null,
  status text not null default 'active'
    check (status in ('active', 'inactive')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (client_id, normalized_name)
);

create index if not exists vendors_client_status_idx
  on vendors (client_id, status);

alter table vendors
  drop constraint if exists vendors_client_id_id_unique;

alter table vendors
  add constraint vendors_client_id_id_unique
  unique (client_id, id);

create table if not exists vendor_aliases (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  merchant_pattern text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (client_id, merchant_pattern)
);

alter table vendor_aliases
  drop constraint if exists vendor_aliases_client_vendor_fk;

alter table vendor_aliases
  add constraint vendor_aliases_client_vendor_fk
  foreign key (client_id, vendor_id)
  references vendors(client_id, id)
  on delete cascade;

create index if not exists vendor_aliases_vendor_idx
  on vendor_aliases (vendor_id);

create table if not exists recurring_transaction_candidates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  account_id uuid not null references accounts(id) on delete cascade,
  vendor_id uuid references vendors(id) on delete set null,
  merchant_pattern text not null,
  cadence text not null
    check (cadence in ('weekly', 'monthly', 'quarterly', 'annual')),
  expected_amount numeric(14,2),
  amount_tolerance numeric(14,2) not null default 0
    check (amount_tolerance >= 0),
  occurrence_count integer not null
    check (occurrence_count >= 2),
  first_occurrence_date date not null,
  last_occurrence_date date not null,
  next_expected_date date,
  confidence_score numeric(4,3) not null
    check (confidence_score >= 0 and confidence_score <= 1),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'detected'
    check (status in ('detected', 'confirmed', 'dismissed')),
  detected_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint recurring_candidate_date_order
    check (first_occurrence_date <= last_occurrence_date),
  unique (client_id, account_id, merchant_pattern, cadence)
);

alter table recurring_transaction_candidates
  drop constraint if exists recurring_candidates_client_vendor_fk;

alter table recurring_transaction_candidates
  add constraint recurring_candidates_client_vendor_fk
  foreign key (client_id, vendor_id)
  references vendors(client_id, id)
  on delete restrict;

create index if not exists recurring_candidates_client_status_idx
  on recurring_transaction_candidates (client_id, status);

create index if not exists recurring_candidates_next_expected_idx
  on recurring_transaction_candidates (client_id, next_expected_date)
  where status = 'confirmed';

alter table vendors enable row level security;
alter table vendor_aliases enable row level security;
alter table recurring_transaction_candidates enable row level security;

drop policy if exists "firm members can view vendors" on vendors;
create policy "firm members can view vendors"
  on vendors for select
  using (
    client_id in (
      select c.id
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where fu.user_id = auth.uid()
    )
  );

drop policy if exists "firm members can view vendor aliases" on vendor_aliases;
create policy "firm members can view vendor aliases"
  on vendor_aliases for select
  using (
    client_id in (
      select c.id
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where fu.user_id = auth.uid()
    )
  );

drop policy if exists "firm members can view recurring candidates" on recurring_transaction_candidates;
create policy "firm members can view recurring candidates"
  on recurring_transaction_candidates for select
  using (
    client_id in (
      select c.id
      from clients c
      join firm_users fu on fu.firm_id = c.firm_id
      where fu.user_id = auth.uid()
    )
  );

revoke insert, update, delete on vendors from authenticated;
revoke insert, update, delete on vendor_aliases from authenticated;
revoke insert, update, delete on recurring_transaction_candidates from authenticated;

revoke all on vendors from anon;
revoke all on vendor_aliases from anon;
revoke all on recurring_transaction_candidates from anon;

create or replace function normalize_vendor_merchant(p_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(
    trim(
      regexp_replace(
        lower(normalize(coalesce(p_value, ''), NFKC)),
        '[^a-z0-9]+',
        ' ',
        'g'
      )
    ),
    ''
  );
$$;

create or replace function upsert_detected_recurring_candidate(
  p_client_id uuid,
  p_account_id uuid,
  p_merchant_pattern text,
  p_cadence text,
  p_expected_amount numeric,
  p_amount_tolerance numeric,
  p_occurrence_count integer,
  p_first_occurrence_date date,
  p_last_occurrence_date date,
  p_next_expected_date date,
  p_confidence_score numeric,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate_id uuid;
  v_merchant_pattern text;
  v_vendor_id uuid;
begin
  if p_cadence not in ('weekly', 'monthly', 'quarterly', 'annual') then
    raise exception 'Unsupported recurring cadence.';
  end if;

  if p_occurrence_count < 2 then
    raise exception 'At least two occurrences are required for recurring evidence.';
  end if;

  if p_first_occurrence_date is null
     or p_last_occurrence_date is null
     or p_first_occurrence_date > p_last_occurrence_date then
    raise exception 'Recurring occurrence dates are invalid.';
  end if;

  if p_confidence_score is null
     or p_confidence_score < 0
     or p_confidence_score > 1 then
    raise exception 'Recurring confidence must be between zero and one.';
  end if;

  if coalesce(p_amount_tolerance, 0) < 0 then
    raise exception 'Amount tolerance cannot be negative.';
  end if;

  v_merchant_pattern := normalize_vendor_merchant(p_merchant_pattern);

  if v_merchant_pattern is null then
    raise exception 'A normalized merchant pattern is required.';
  end if;

  if not exists (
    select 1
    from accounts a
    join plaid_items pi on pi.id = a.plaid_item_id
    where a.id = p_account_id
      and pi.client_id = p_client_id
  ) then
    raise exception 'Account does not belong to the selected client.';
  end if;

  select va.vendor_id
    into v_vendor_id
  from vendor_aliases va
  join vendors v on v.id = va.vendor_id
  where va.client_id = p_client_id
    and va.merchant_pattern = v_merchant_pattern
    and v.client_id = p_client_id
    and v.status = 'active'
  limit 1;

  insert into recurring_transaction_candidates (
    client_id,
    account_id,
    vendor_id,
    merchant_pattern,
    cadence,
    expected_amount,
    amount_tolerance,
    occurrence_count,
    first_occurrence_date,
    last_occurrence_date,
    next_expected_date,
    confidence_score,
    evidence,
    status
  )
  values (
    p_client_id,
    p_account_id,
    v_vendor_id,
    v_merchant_pattern,
    p_cadence,
    case when p_expected_amount is null then null else round(p_expected_amount, 2) end,
    round(coalesce(p_amount_tolerance, 0), 2),
    p_occurrence_count,
    p_first_occurrence_date,
    p_last_occurrence_date,
    p_next_expected_date,
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb),
    'detected'
  )
  on conflict (client_id, account_id, merchant_pattern, cadence)
  do update set
    vendor_id = coalesce(
      recurring_transaction_candidates.vendor_id,
      excluded.vendor_id
    ),
    expected_amount = excluded.expected_amount,
    amount_tolerance = excluded.amount_tolerance,
    occurrence_count = excluded.occurrence_count,
    first_occurrence_date = excluded.first_occurrence_date,
    last_occurrence_date = excluded.last_occurrence_date,
    next_expected_date = excluded.next_expected_date,
    confidence_score = excluded.confidence_score,
    evidence = excluded.evidence,
    updated_at = now()
  returning id into v_candidate_id;

  return v_candidate_id;
end;
$$;

create or replace function create_or_link_vendor(
  p_client_id uuid,
  p_display_name text,
  p_merchant_pattern text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_normalized_name text;
  v_merchant_pattern text;
  v_vendor_id uuid;
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
    raise exception 'User is not authorized to manage vendors for this client.';
  end if;

  v_normalized_name := normalize_vendor_merchant(p_display_name);
  v_merchant_pattern := normalize_vendor_merchant(p_merchant_pattern);

  if v_normalized_name is null or v_merchant_pattern is null then
    raise exception 'Vendor name and merchant pattern are required.';
  end if;

  insert into vendors (
    client_id,
    display_name,
    normalized_name,
    created_by
  )
  values (
    p_client_id,
    btrim(p_display_name),
    v_normalized_name,
    v_user_id
  )
  on conflict (client_id, normalized_name)
  do update set
    display_name = excluded.display_name,
    status = 'active',
    updated_at = now()
  returning id into v_vendor_id;

  insert into vendor_aliases (
    client_id,
    vendor_id,
    merchant_pattern,
    created_by
  )
  values (
    p_client_id,
    v_vendor_id,
    v_merchant_pattern,
    v_user_id
  )
  on conflict (client_id, merchant_pattern)
  do update set
    vendor_id = excluded.vendor_id;

  update recurring_transaction_candidates
  set vendor_id = v_vendor_id,
      updated_at = now()
  where client_id = p_client_id
    and merchant_pattern = v_merchant_pattern
    and status <> 'dismissed';

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'vendor_identity_linked',
    jsonb_build_object(
      'vendor_id', v_vendor_id,
      'merchant_pattern', v_merchant_pattern
    )
  );

  return v_vendor_id;
end;
$$;

create or replace function review_recurring_transaction_candidate(
  p_candidate_id uuid,
  p_client_id uuid,
  p_action text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_candidate recurring_transaction_candidates%rowtype;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_action not in ('confirm', 'dismiss') then
    raise exception 'Recurring review action must be confirm or dismiss.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to review recurring evidence for this client.';
  end if;

  select *
    into v_candidate
  from recurring_transaction_candidates
  where id = p_candidate_id
    and client_id = p_client_id
  for update;

  if not found then
    raise exception 'Recurring candidate not found.';
  end if;

  if v_candidate.status <> 'detected' then
    raise exception 'Only detected recurring candidates can be reviewed.';
  end if;

  v_status := case when p_action = 'confirm' then 'confirmed' else 'dismissed' end;

  update recurring_transaction_candidates
  set status = v_status,
      reviewed_by = v_user_id,
      reviewed_at = now(),
      updated_at = now()
  where id = v_candidate.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    case
      when p_action = 'confirm' then 'recurring_candidate_confirmed'
      else 'recurring_candidate_dismissed'
    end,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'account_id', v_candidate.account_id,
      'vendor_id', v_candidate.vendor_id,
      'merchant_pattern', v_candidate.merchant_pattern,
      'cadence', v_candidate.cadence
    )
  );

  return v_candidate.id;
end;
$$;

revoke all on function normalize_vendor_merchant(text) from public;
grant execute on function normalize_vendor_merchant(text) to authenticated, service_role;

revoke all on function upsert_detected_recurring_candidate(
  uuid, uuid, text, text, numeric, numeric, integer, date, date, date, numeric, jsonb
) from public, anon, authenticated;
grant execute on function upsert_detected_recurring_candidate(
  uuid, uuid, text, text, numeric, numeric, integer, date, date, date, numeric, jsonb
) to service_role;

revoke all on function create_or_link_vendor(uuid, text, text)
  from public, anon;
grant execute on function create_or_link_vendor(uuid, text, text)
  to authenticated;

revoke all on function review_recurring_transaction_candidate(uuid, uuid, text)
  from public, anon;
grant execute on function review_recurring_transaction_candidate(uuid, uuid, text)
  to authenticated;

comment on table vendors is
  'Client-scoped vendor identities explicitly created or linked by authorized accounting users. Vendor identity does not itself alter transaction bookkeeping.';

comment on table vendor_aliases is
  'Normalized bank merchant patterns explicitly linked to a client vendor identity.';

comment on table recurring_transaction_candidates is
  'Evidence-only recurring transaction patterns. Detection and confirmation do not create bills, payments, journals, transaction confirmations, or financial reporting entries.';
