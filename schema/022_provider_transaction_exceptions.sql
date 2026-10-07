-- ============================================================
-- MIGRATION 022
-- PLAID PROVIDER TRANSACTION EXCEPTIONS
--
-- Durable evidence queue for provider changes that cannot safely be
-- applied to a transaction while an active posted journal exists.
--
-- This migration creates the queue only. It does not change Plaid sync
-- behavior, transaction financial state, journal entries, or reporting.
-- ============================================================

create table provider_transaction_exceptions (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  plaid_item_id uuid not null references plaid_items(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  plaid_transaction_id text not null,
  event_type text not null
    check (event_type in ('modified', 'removed')),
  current_values jsonb not null default '{}'::jsonb,
  proposed_values jsonb not null default '{}'::jsonb,
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id),
  resolution_note text,
  constraint provider_transaction_exceptions_resolution_state_check
    check (
      (status = 'open' and resolved_at is null and resolved_by is null)
      or
      (status in ('resolved', 'dismissed') and resolved_at is not null)
    )
);

create unique index provider_transaction_exceptions_open_event_unique
  on provider_transaction_exceptions (
    plaid_item_id,
    transaction_id,
    event_type
  )
  where status = 'open';

create index provider_transaction_exceptions_client_status_idx
  on provider_transaction_exceptions (client_id, status, last_seen_at desc);

create index provider_transaction_exceptions_transaction_idx
  on provider_transaction_exceptions (transaction_id);

alter table provider_transaction_exceptions enable row level security;

create policy "firm members can view provider transaction exceptions"
on provider_transaction_exceptions
for select
using (
  exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = provider_transaction_exceptions.client_id
      and fu.user_id = auth.uid()
  )
);

create policy "accounting roles can update provider transaction exceptions"
on provider_transaction_exceptions
for update
using (
  exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = provider_transaction_exceptions.client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
)
with check (
  exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = provider_transaction_exceptions.client_id
      and fu.user_id = auth.uid()
      and fu.role in ('owner', 'admin', 'bookkeeper')
  )
);

-- Ordinary authenticated users cannot create/delete provider evidence.
-- Server-side Plaid ingestion uses the service role to capture events.
revoke insert, delete on provider_transaction_exceptions from authenticated;
revoke all on provider_transaction_exceptions from anon;

comment on table provider_transaction_exceptions is
  'Durable provider-change evidence for Plaid modified/removed events that cannot be applied while a transaction has an active posted journal.';

comment on column provider_transaction_exceptions.current_values is
  'LedgerAI source values at the time the provider event was captured.';

comment on column provider_transaction_exceptions.proposed_values is
  'Provider-supplied values LedgerAI intentionally did not apply automatically.';

comment on column provider_transaction_exceptions.status is
  'Human accounting resolution state. Open evidence does not mutate transaction or journal financial state.';
