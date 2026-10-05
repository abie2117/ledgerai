-- ============================================================
-- MIGRATION 026
-- ATOMIC PROVIDER INGESTION + EXCEPTION SUPERSESSION
--
-- Serializes Plaid provider changes with journal posting by locking the
-- transaction row first. Applies provider state when no active journal
-- exists; otherwise captures durable evidence. New provider evidence
-- supersedes older open evidence for the same transaction.
-- ============================================================

alter table provider_transaction_exceptions
  drop constraint if exists provider_transaction_exceptions_status_check;

alter table provider_transaction_exceptions
  add constraint provider_transaction_exceptions_status_check
  check (status in ('open', 'resolved', 'dismissed', 'superseded'));

create or replace function apply_or_capture_provider_transaction_change(
  p_client_id uuid,
  p_plaid_item_id uuid,
  p_plaid_transaction_id text,
  p_event_type text,
  p_account_id uuid default null,
  p_posted_date date default null,
  p_amount numeric default null,
  p_merchant_name text default null,
  p_raw_plaid_category text default null
)
returns table (
  transaction_id uuid,
  outcome text,
  provider_exception_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_transaction transactions%rowtype;
  v_has_active_journal boolean := false;
  v_exception_id uuid;
  v_current_values jsonb;
  v_proposed_values jsonb;
begin
  if p_event_type not in ('modified', 'removed', 'reappeared') then
    raise exception 'Unsupported provider transaction event type.';
  end if;

  if not exists (
    select 1
    from plaid_items pi
    where pi.id = p_plaid_item_id
      and pi.client_id = p_client_id
  ) then
    raise exception 'Plaid Item does not belong to the specified client.';
  end if;

  select t.*
    into v_transaction
  from transactions t
  join accounts a on a.id = t.account_id
  where t.client_id = p_client_id
    and t.plaid_transaction_id = p_plaid_transaction_id
    and a.plaid_item_id = p_plaid_item_id
  for update of t;

  if not found then
    raise exception 'Provider transaction not found for the specified Plaid Item and client.';
  end if;

  if p_event_type in ('modified', 'reappeared') then
    if p_account_id is null
       or p_posted_date is null
       or p_amount is null then
      raise exception 'Provider transaction values are incomplete.';
    end if;

    if not exists (
      select 1
      from accounts a
      where a.id = p_account_id
        and a.plaid_item_id = p_plaid_item_id
    ) then
      raise exception 'Provider change references an account outside the selected Plaid Item.';
    end if;
  end if;

  select exists (
    select 1
    from journal_entries je
    where je.transaction_id = v_transaction.id
      and je.client_id = p_client_id
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  )
  into v_has_active_journal;

  v_current_values := jsonb_build_object(
    'account_id', v_transaction.account_id,
    'posted_date', v_transaction.posted_date,
    'amount', v_transaction.amount,
    'merchant_name', v_transaction.merchant_name,
    'raw_plaid_category', v_transaction.raw_plaid_category,
    'plaid_removed_at', v_transaction.plaid_removed_at
  );

  v_proposed_values :=
    case
      when p_event_type = 'removed' then
        jsonb_build_object('plaid_removed_at', now())
      else
        jsonb_build_object(
          'account_id', p_account_id,
          'posted_date', p_posted_date,
          'amount', p_amount,
          'merchant_name', p_merchant_name,
          'raw_plaid_category', p_raw_plaid_category,
          'plaid_removed_at',
            case
              when p_event_type = 'reappeared' then null
              else v_transaction.plaid_removed_at
            end
        )
    end;

  if v_has_active_journal then
    update provider_transaction_exceptions
    set status = 'superseded',
        resolved_at = now(),
        resolved_by = null,
        resolution_note = 'Superseded by a newer provider event.'
    where client_id = p_client_id
      and transaction_id = v_transaction.id
      and status = 'open'
      and event_type <> p_event_type;

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
      v_transaction.id,
      p_plaid_transaction_id,
      p_event_type,
      v_current_values,
      v_proposed_values,
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

    return query
      select v_transaction.id, 'captured'::text, v_exception_id;
    return;
  end if;

  -- With the transaction row locked, journal posting cannot create an active
  -- journal between the check above and the provider-owned mutation below.
  if p_event_type = 'removed' then
    update transactions
    set plaid_removed_at = now(),
        updated_at = now()
    where id = v_transaction.id
      and client_id = p_client_id;

  elsif p_event_type = 'reappeared' then
    update transactions
    set account_id = p_account_id,
        posted_date = p_posted_date,
        amount = p_amount,
        merchant_name = p_merchant_name,
        raw_plaid_category = p_raw_plaid_category,
        plaid_removed_at = null,
        updated_at = now()
    where id = v_transaction.id
      and client_id = p_client_id;

  else
    update transactions
    set account_id = p_account_id,
        posted_date = p_posted_date,
        amount = p_amount,
        merchant_name = p_merchant_name,
        raw_plaid_category = p_raw_plaid_category,
        updated_at = now()
    where id = v_transaction.id
      and client_id = p_client_id;
  end if;

  -- Provider state was applied directly, so any older unresolved provider
  -- evidence for this transaction is stale and must not remain actionable.
  update provider_transaction_exceptions
  set status = 'superseded',
      resolved_at = now(),
      resolved_by = null,
      resolution_note = 'Superseded because newer provider state was applied directly.'
  where client_id = p_client_id
    and transaction_id = v_transaction.id
    and status = 'open';

  return query
    select v_transaction.id, 'applied'::text, null::uuid;
end;
$$;

revoke all on function apply_or_capture_provider_transaction_change(
  uuid, uuid, text, text, uuid, date, numeric, text, text
) from public;
revoke all on function apply_or_capture_provider_transaction_change(
  uuid, uuid, text, text, uuid, date, numeric, text, text
) from anon;
revoke all on function apply_or_capture_provider_transaction_change(
  uuid, uuid, text, text, uuid, date, numeric, text, text
) from authenticated;
grant execute on function apply_or_capture_provider_transaction_change(
  uuid, uuid, text, text, uuid, date, numeric, text, text
) to service_role;

comment on function apply_or_capture_provider_transaction_change(
  uuid, uuid, text, text, uuid, date, numeric, text, text
) is
  'Service-role Plaid ingestion boundary. Locks the transaction, atomically chooses direct provider-state application versus durable exception capture, and supersedes stale open provider evidence.';

-- Existing capture remains available for compatibility, but make its sibling
-- semantics consistent if it is called by an older application deployment.
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
  v_locked_transaction_id uuid;
begin
  if p_event_type not in ('modified', 'removed', 'reappeared') then
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

  select t.id
    into v_locked_transaction_id
  from transactions t
  join accounts a on a.id = t.account_id
  where t.id = p_transaction_id
    and t.client_id = p_client_id
    and t.plaid_transaction_id = p_plaid_transaction_id
    and a.plaid_item_id = p_plaid_item_id
  for update of t;

  if not found then
    raise exception 'Transaction does not belong to the specified Plaid Item and client.';
  end if;

  if not exists (
    select 1
    from journal_entries je
    where je.transaction_id = p_transaction_id
      and je.client_id = p_client_id
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  ) then
    raise exception 'Provider exception capture requires an active draft or posted journal.';
  end if;

  update provider_transaction_exceptions
  set status = 'superseded',
      resolved_at = now(),
      resolved_by = null,
      resolution_note = 'Superseded by a newer provider event.'
  where client_id = p_client_id
    and transaction_id = p_transaction_id
    and status = 'open'
    and event_type <> p_event_type;

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
