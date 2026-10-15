-- ============================================================
-- DUPLICATE CANDIDATES
-- Evidence-only bookkeeping duplicate review.
--
-- This table never removes, excludes, confirms, or otherwise mutates
-- transactions. It records a suspected pair so a human can resolve it.
-- ============================================================

create table duplicate_candidates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  transaction_a_id uuid not null references transactions(id) on delete cascade,
  transaction_b_id uuid not null references transactions(id) on delete cascade,
  severity text not null default 'low'
    check (severity in ('low', 'medium', 'high')),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'dismissed', 'resolved')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  constraint duplicate_candidates_distinct_transactions
    check (transaction_a_id <> transaction_b_id),
  constraint duplicate_candidates_canonical_pair
    check (transaction_a_id::text < transaction_b_id::text),
  unique (client_id, transaction_a_id, transaction_b_id)
);

create index duplicate_candidates_client_status_idx
  on duplicate_candidates (client_id, status);

create index duplicate_candidates_transaction_a_idx
  on duplicate_candidates (transaction_a_id);

create index duplicate_candidates_transaction_b_idx
  on duplicate_candidates (transaction_b_id);

alter table duplicate_candidates enable row level security;

create policy "firm members can access duplicate candidates for their clients"
  on duplicate_candidates
  for all
  using (
    client_id in (
      select id
      from clients
      where firm_id in (select firm_id from my_firms)
    )
  )
  with check (
    client_id in (
      select id
      from clients
      where firm_id in (select firm_id from my_firms)
    )
  );

comment on table duplicate_candidates is
  'Evidence-only suspected bookkeeping duplicate pairs. Detection does not alter transaction financial state.';
comment on column duplicate_candidates.evidence is
  'Structured detector evidence such as amount/date/merchant/account agreement. Never treated as an automatic duplicate verdict.';
