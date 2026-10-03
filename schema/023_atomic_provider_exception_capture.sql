-- ============================================================
-- MIGRATION 023
-- ATOMIC PLAID PROVIDER EXCEPTION CAPTURE
--
-- Captures or refreshes one open provider-change exception atomically.
-- Intended for trusted server-side Plaid ingestion. It does not mutate
-- transactions, journals, or the Plaid cursor.
-- ============================================================

create or replace function capture_provider_transaction_exception(
  p_client_id uuid,
  p_plaid_item_id uuid,
  p_transaction_id uuid,
  p_plaid_transaction_id text,
  p_event_type text,
  p_current_values jsonb,
  p_proposed_values jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exception_id uuid;
begin
  if p_event_type not in ('modified', 'removed') then
    raise exception 'Unsupported provider transaction exception event type.';
  end if;

  if not exists (
    select 1
    from plaid_items pi
    where pi.id = p_plaid_item_id
      and pi.client_id = p_client_id
  ) then
    raise exception 'Plaid Item does not belong to the specified client.';
  end if;

  if not exists (
    select 1
    from transactions t
    join accounts a on a.id = t.account_id
    where t.id = p_transaction_id
      and t.client_id = p_client_id
      and t.plaid_transaction_id = p_plaid_transaction_id
      and a.plaid_item_id = p_plaid_item_id
  ) then
    raise exception 'Transaction does not belong to the specified Plaid Item and client.';
  end if;

  if not exists (
    select 1
    from journal_entries je
    where je.transaction_id = p_transaction_id
      and je.client_id = p_client_id
      and je.reversal_of_journal_entry_id is null
      and je.status = 'posted'
  ) then
    raise exception 'Provider exception capture requires an active posted journal.';
  end if;

  insert into provider_transaction_exceptions (
    client_id,
    plaid_item_id,
    transaction_id,
    plaid_transaction_id,
    event_type,
    current_values,
    proposed_values,
    status,
    first_seen_at,
    last_seen_at
  )
  values (
    p_client_id,
    p_plaid_item_id,
    p_transaction_id,
    p_plaid_transaction_id,
    p_event_type,
    coalesce(p_current_values, '{}'::jsonb),
    coalesce(p_proposed_values, '{}'::jsonb),
    'open',
    now(),
    now()
  )
  on conflict (
    plaid_item_id,
    transaction_id,
    event_type
  )
  where status = 'open'
  do update set
    current_values = excluded.current_values,
    proposed_values = excluded.proposed_values,
    last_seen_at = now()
  returning id into v_exception_id;

  return v_exception_id;
end;
$$;

revoke all on function capture_provider_transaction_exception(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) from public;

revoke all on function capture_provider_transaction_exception(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) from anon;

revoke all on function capture_provider_transaction_exception(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) from authenticated;

grant execute on function capture_provider_transaction_exception(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) to service_role;

comment on function capture_provider_transaction_exception(
  uuid, uuid, uuid, text, text, jsonb, jsonb
) is
  'Atomically captures or refreshes an open Plaid provider-change exception for an actively posted transaction. Service-role ingestion only; does not mutate financial state.';
