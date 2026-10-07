-- ============================================================
-- MIGRATION 025
-- PROVIDER REAPPEARANCE + ACTIVE JOURNAL PROTECTION
--
-- Extends provider evidence to cover Plaid transactions that reappear
-- after soft removal and protects both draft and posted active journals.
-- ============================================================

alter table provider_transaction_exceptions
  drop constraint if exists provider_transaction_exceptions_event_type_check;

alter table provider_transaction_exceptions
  add constraint provider_transaction_exceptions_event_type_check
  check (event_type in ('modified', 'removed', 'reappeared'));

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
      and je.status in ('draft', 'posted')
  ) then
    raise exception 'Provider exception capture requires an active draft or posted journal.';
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

create or replace function protect_active_transaction_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from journal_entries je
    where je.transaction_id = old.id
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  ) then
    if new.client_id is distinct from old.client_id
       or new.account_id is distinct from old.account_id
       or new.posted_date is distinct from old.posted_date
       or new.amount is distinct from old.amount
       or new.merchant_name is distinct from old.merchant_name
       or new.ai_category_id is distinct from old.ai_category_id
       or new.category is distinct from old.category
       or new.duplicate_of_transaction_id is distinct from old.duplicate_of_transaction_id
       or new.plaid_removed_at is distinct from old.plaid_removed_at then
      raise exception
        'Transaction with an active draft or posted journal cannot be changed until the journal lifecycle is resolved.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_posted_transaction_source_trigger
  on transactions;
drop trigger if exists protect_active_transaction_source_trigger
  on transactions;

create trigger protect_active_transaction_source_trigger
before update of
  client_id,
  account_id,
  posted_date,
  amount,
  merchant_name,
  ai_category_id,
  category,
  duplicate_of_transaction_id,
  plaid_removed_at
on transactions
for each row
execute function protect_active_transaction_source();

comment on function protect_active_transaction_source() is
  'Prevents bookkeeping-significant source changes while an active original draft or posted journal exists.';

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

  if p_action not in ('accept', 'dismiss') then
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
    and client_id = p_client_id
  for update;

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

revoke all on function resolve_provider_transaction_exception(
  uuid, uuid, text, text
) from public;
revoke all on function resolve_provider_transaction_exception(
  uuid, uuid, text, text
) from anon;
grant execute on function resolve_provider_transaction_exception(
  uuid, uuid, text, text
) to authenticated;

comment on function resolve_provider_transaction_exception(
  uuid, uuid, text, text
) is
  'Controlled resolution for modified, removed, and reappeared Plaid provider changes. Active drafts block acceptance; posted changes reverse and apply atomically.';
