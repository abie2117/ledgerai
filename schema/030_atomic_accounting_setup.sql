-- ============================================================
-- MIGRATION 030
-- ATOMIC ACCOUNTING SETUP MUTATION
--
-- Makes connected-account mapping, ledger-account creation + mapping, and
-- unmapping a single auditable database transaction.
-- ============================================================

create or replace function mutate_accounting_setup(
  p_client_id uuid,
  p_account_id uuid,
  p_action text,
  p_category_id uuid default null,
  p_name text default null,
  p_coa_code text default null,
  p_account_type text default null
)
returns table (
  account_id uuid,
  coa_category_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_account accounts%rowtype;
  v_category categories%rowtype;
  v_category_id uuid;
  v_name text;
  v_code text;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_action not in ('map', 'create_and_map', 'unmap') then
    raise exception 'Unsupported accounting setup action.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'Owner, admin, or bookkeeper access is required to change accounting setup.';
  end if;

  -- Lock the connected account before validation/mutation. This also
  -- serializes against reconciliation/posting boundaries that lock the same
  -- account row.
  select a.*
    into v_account
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  where a.id = p_account_id
    and pi.client_id = p_client_id
  for update of a;

  if not found then
    raise exception 'Connected account not found for this client.';
  end if;

  if p_action = 'map' then
    if p_category_id is null then
      raise exception 'A ledger account is required.';
    end if;

    select c.*
      into v_category
    from categories c
    where c.id = p_category_id
      and c.client_id = p_client_id
      and c.account_type in ('asset', 'liability')
      and c.normal_balance in ('debit', 'credit')
      and c.is_active
      and c.is_posting_account
    for update;

    if not found then
      raise exception 'Selected ledger account is not eligible for this client.';
    end if;

    v_category_id := v_category.id;
  elsif p_action = 'create_and_map' then
    v_name := nullif(btrim(p_name), '');
    v_code := nullif(btrim(p_coa_code), '');

    if v_name is null or p_account_type not in ('asset', 'liability') then
      raise exception 'A ledger account name and Asset or Liability type are required.';
    end if;

    insert into categories (
      client_id,
      name,
      coa_code,
      account_type,
      normal_balance,
      is_posting_account,
      is_active,
      is_default
    )
    values (
      p_client_id,
      v_name,
      v_code,
      p_account_type,
      case when p_account_type = 'asset' then 'debit' else 'credit' end,
      true,
      true,
      false
    )
    returning id into v_category_id;
  else
    v_category_id := null;
  end if;

  -- Existing validation and active-journal protection triggers remain the
  -- final accounting safety boundary. Any failure rolls back category
  -- creation and mapping together.
  update accounts
  set coa_category_id = v_category_id
  where id = v_account.id;

  if not found then
    raise exception 'Connected account changed before accounting setup could complete.';
  end if;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    case p_action
      when 'map' then 'connected_account_mapped'
      when 'create_and_map' then 'ledger_account_created_and_mapped'
      else 'connected_account_unmapped'
    end,
    jsonb_build_object(
      'account_id', v_account.id,
      'previous_coa_category_id', v_account.coa_category_id,
      'coa_category_id', v_category_id,
      'created_ledger_account', p_action = 'create_and_map'
    )
  );

  return query
  select v_account.id, v_category_id;
end;
$$;

revoke all on function mutate_accounting_setup(uuid,uuid,text,uuid,text,text,text) from public;
revoke all on function mutate_accounting_setup(uuid,uuid,text,uuid,text,text,text) from anon;
grant execute on function mutate_accounting_setup(uuid,uuid,text,uuid,text,text,text) to authenticated;

comment on function mutate_accounting_setup(uuid,uuid,text,uuid,text,text,text) is
  'Atomically maps, creates-and-maps, or unmaps a connected account with accounting-role authorization, row locking, existing mapping safeguards, and audit history.';
