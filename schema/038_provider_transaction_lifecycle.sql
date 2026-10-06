-- Complete the superseded state introduced in migration 026.
alter table provider_transaction_exceptions
  drop constraint provider_transaction_exceptions_resolution_state_check;
alter table provider_transaction_exceptions
  add constraint provider_transaction_exceptions_resolution_state_check
  check (
    (status = 'open' and resolved_at is null and resolved_by is null)
    or (status in ('resolved', 'dismissed') and resolved_at is not null)
    or (status = 'superseded' and resolved_at is not null and resolved_by is null)
  );

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
#variable_conflict use_column
declare
  v_transaction transactions%rowtype;
  v_has_active_journal boolean := false;
  v_exception_id uuid;
  v_current_values jsonb;
  v_proposed_values jsonb;
begin
  if p_event_type is null or p_event_type not in ('modified', 'removed', 'reappeared') then
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

-- Serialize provider review with ingestion using transaction then exception locks.
create or replace function resolve_provider_transaction_exception(
  p_exception_id uuid,
  p_client_id uuid,
  p_action text,
  p_resolution_note text default null
)
returns table (
  exception_id uuid,
  transaction_id uuid,
  event_type text,
  resolution_status text,
  journal_reposted boolean
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_user_id uuid := auth.uid();
  v_exception provider_transaction_exceptions%rowtype;
  v_transaction transactions%rowtype;
  v_active_journal journal_entries%rowtype;
  v_new_account_id uuid;
  v_new_posted_date date;
  v_new_amount numeric;
  v_new_merchant_name text;
  v_new_raw_plaid_category text;
  v_reposted boolean := false;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_action is null or p_action not in ('accept', 'dismiss') then
    raise exception 'Resolution action must be accept or dismiss.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to resolve provider exceptions for this client.';
  end if;

  select *
    into v_exception
  from provider_transaction_exceptions
  where id = p_exception_id
    and client_id = p_client_id;

  if not found then
    raise exception 'Provider transaction exception not found.';
  end if;

  if v_exception.status <> 'open' then
    raise exception 'Provider transaction exception is no longer open.';
  end if;

  select *
    into v_transaction
  from transactions
  where id = v_exception.transaction_id
    and client_id = p_client_id
    and plaid_transaction_id = v_exception.plaid_transaction_id
  for update;

  if not found then
    raise exception 'Provider exception transaction not found.';
  end if;

  -- Ingestion locks the transaction before superseding or updating exceptions.
  -- Re-read the exception after waiting so stale evidence cannot be accepted.
  select * into v_exception
  from provider_transaction_exceptions
  where id = p_exception_id
    and client_id = p_client_id
    and transaction_id = v_transaction.id
    and plaid_transaction_id = v_transaction.plaid_transaction_id
  for update;

  if not found or v_exception.status <> 'open' then
    raise exception 'Provider transaction exception is no longer open.';
  end if;

  if p_action = 'dismiss' then
    update provider_transaction_exceptions
    set status = 'dismissed',
        resolved_at = now(),
        resolved_by = v_user_id,
        resolution_note = nullif(btrim(p_resolution_note), '')
    where id = v_exception.id;

    insert into audit_log (actor_id, client_id, action, detail)
    values (
      v_user_id,
      p_client_id,
      'provider_transaction_exception_dismissed',
      jsonb_build_object(
        'provider_exception_id', v_exception.id,
        'transaction_id', v_transaction.id,
        'event_type', v_exception.event_type,
        'resolution_note', nullif(btrim(p_resolution_note), '')
      )
    );

    return query
      select v_exception.id, v_transaction.id, v_exception.event_type,
             'dismissed'::text, false;
    return;
  end if;

  select je.*
    into v_active_journal
  from journal_entries je
  where je.transaction_id = v_transaction.id
    and je.client_id = p_client_id
    and je.reversal_of_journal_entry_id is null
    and je.status in ('draft', 'posted')
  for update;

  if not found then
    raise exception 'Transaction no longer has the active journal required for provider resolution.';
  end if;

  if v_active_journal.status = 'draft' then
    raise exception 'Transaction has an active draft journal that must be resolved first.';
  end if;

  perform reverse_journal_entry(v_active_journal.id, p_client_id);

  if v_exception.event_type in ('modified', 'reappeared') then
    if not (
      v_exception.proposed_values ? 'account_id'
      and v_exception.proposed_values ? 'posted_date'
      and v_exception.proposed_values ? 'amount'
      and v_exception.proposed_values ? 'merchant_name'
      and v_exception.proposed_values ? 'raw_plaid_category'
    ) then
      raise exception 'Provider exception does not contain the required provider values.';
    end if;

    begin
      v_new_account_id := (v_exception.proposed_values ->> 'account_id')::uuid;
      v_new_posted_date := (v_exception.proposed_values ->> 'posted_date')::date;
      v_new_amount := (v_exception.proposed_values ->> 'amount')::numeric;
      v_new_merchant_name := v_exception.proposed_values ->> 'merchant_name';
      v_new_raw_plaid_category := v_exception.proposed_values ->> 'raw_plaid_category';
    exception when others then
      raise exception 'Provider exception contains invalid provider values.';
    end;

    if not exists (
      select 1
      from accounts a
      join plaid_items pi on pi.id = a.plaid_item_id
      where a.id = v_new_account_id
        and pi.id = v_exception.plaid_item_id
        and pi.client_id = p_client_id
    ) then
      raise exception 'Provider change references an account outside the selected Plaid Item.';
    end if;

    update transactions
    set account_id = v_new_account_id,
        posted_date = v_new_posted_date,
        amount = v_new_amount,
        merchant_name = v_new_merchant_name,
        raw_plaid_category = v_new_raw_plaid_category,
        plaid_removed_at = case
          when v_exception.event_type = 'reappeared' then null
          else plaid_removed_at
        end,
        updated_at = now()
    where id = v_transaction.id
      and client_id = p_client_id;

    perform post_transaction_to_journal(v_transaction.id, p_client_id);
    v_reposted := true;

  elsif v_exception.event_type = 'removed' then
    update transactions
    set plaid_removed_at = now(),
        updated_at = now()
    where id = v_transaction.id
      and client_id = p_client_id;

  else
    raise exception 'Unsupported provider exception event type.';
  end if;

  update provider_transaction_exceptions
  set status = 'resolved',
      resolved_at = now(),
      resolved_by = v_user_id,
      resolution_note = nullif(btrim(p_resolution_note), '')
  where id = v_exception.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'provider_transaction_exception_accepted',
    jsonb_build_object(
      'provider_exception_id', v_exception.id,
      'transaction_id', v_transaction.id,
      'event_type', v_exception.event_type,
      'reversed_journal_entry_id', v_active_journal.id,
      'journal_reposted', v_reposted,
      'resolution_note', nullif(btrim(p_resolution_note), '')
    )
  );

  return query
    select v_exception.id, v_transaction.id, v_exception.event_type,
           'resolved'::text, v_reposted;
end;
$$;

