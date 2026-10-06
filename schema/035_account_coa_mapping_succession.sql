-- ============================================================
-- MIGRATION 035
-- SAFE COA MAPPING SUCCESSION FOR SUPERSEDED FINANCIAL SOURCES
--
-- Allows an active retained Plaid account to inherit a COA mapping from an
-- account on the Plaid Item it explicitly superseded. Historical transactions
-- stay on the old account. No journals or reconciliations are moved.
-- ============================================================

create or replace function map_connected_account_to_coa(
  p_client_id uuid,
  p_target_account_id uuid,
  p_category_id uuid
)
returns table (
  account_id uuid,
  coa_category_id uuid,
  transferred_from_account_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_target accounts%rowtype;
  v_target_item plaid_items%rowtype;
  v_category categories%rowtype;
  v_source accounts%rowtype;
  v_source_item plaid_items%rowtype;
  v_source_account_id uuid;
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
    raise exception 'Owner, admin, or bookkeeper access is required to change accounting setup.';
  end if;

  -- Lock the target account and its Plaid Item.
  select a.*
    into v_target
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  where a.id = p_target_account_id
    and pi.client_id = p_client_id
  for update of a;

  if not found then
    raise exception 'Connected account not found for this client.';
  end if;

  select pi.*
    into v_target_item
  from plaid_items pi
  where pi.id = v_target.plaid_item_id
    and pi.client_id = p_client_id
  for update;

  if not found
     or v_target_item.status <> 'active'
     or v_target_item.financial_source_status <> 'active' then
    raise exception 'Target account must belong to a provider-active and financially active source.';
  end if;

  if v_target.coa_category_id is not null then
    if v_target.coa_category_id = p_category_id then
      return query
      select v_target.id, v_target.coa_category_id, null::uuid;
      return;
    end if;

    raise exception 'Target connected account is already mapped. Unmap it through the controlled accounting setup workflow first.';
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

  -- Find the current owner of this one-to-one COA mapping, if any.
  select a.*
    into v_source
  from accounts a
  join plaid_items pi on pi.id = a.plaid_item_id
  where a.coa_category_id = p_category_id
    and pi.client_id = p_client_id
  for update of a;

  if not found then
    update accounts
    set coa_category_id = p_category_id
    where id = v_target.id;

    insert into audit_log (actor_id, client_id, action, detail)
    values (
      v_user_id,
      p_client_id,
      'connected_account_mapped',
      jsonb_build_object(
        'account_id', v_target.id,
        'previous_coa_category_id', null,
        'coa_category_id', p_category_id,
        'created_ledger_account', false
      )
    );

    return query
    select v_target.id, p_category_id, null::uuid;
    return;
  end if;

  if v_source.id = v_target.id then
    return query
    select v_target.id, p_category_id, null::uuid;
    return;
  end if;

  select pi.*
    into v_source_item
  from plaid_items pi
  where pi.id = v_source.plaid_item_id
    and pi.client_id = p_client_id
  for update;

  if not found
     or v_source_item.financial_source_status <> 'superseded'
     or v_source_item.superseded_by_plaid_item_id is distinct from v_target_item.id then
    raise exception 'Selected ledger account is already mapped to another connected account and is not eligible for supersession transfer.';
  end if;

  -- Mapping succession is only safe before either connected-account identity
  -- participates in active journals or reconciliation history.
  if exists (
    select 1
    from transactions t
    join journal_entries je on je.transaction_id = t.id
    where t.account_id in (v_source.id, v_target.id)
      and je.reversal_of_journal_entry_id is null
      and je.status in ('draft', 'posted')
  ) then
    raise exception 'COA mapping cannot transfer while either connected account has active journal entries.';
  end if;

  if exists (
    select 1
    from reconciliations r
    where r.client_id = p_client_id
      and r.account_id in (v_source.id, v_target.id)
  ) then
    raise exception 'COA mapping cannot transfer after reconciliation history exists for either connected account.';
  end if;

  -- Release first, then acquire. The existing unique partial index guarantees
  -- the category can never be owned by both connected accounts.
  update accounts
  set coa_category_id = null
  where id = v_source.id;

  update accounts
  set coa_category_id = p_category_id
  where id = v_target.id;

  v_source_account_id := v_source.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'connected_account_coa_mapping_transferred',
    jsonb_build_object(
      'source_account_id', v_source.id,
      'source_plaid_item_id', v_source_item.id,
      'target_account_id', v_target.id,
      'target_plaid_item_id', v_target_item.id,
      'coa_category_id', p_category_id,
      'supersession_relationship_verified', true
    )
  );

  return query
  select v_target.id, p_category_id, v_source_account_id;
end;
$$;

revoke all on function map_connected_account_to_coa(uuid, uuid, uuid) from public;
revoke all on function map_connected_account_to_coa(uuid, uuid, uuid) from anon;
grant execute on function map_connected_account_to_coa(uuid, uuid, uuid) to authenticated;

comment on function map_connected_account_to_coa(uuid, uuid, uuid) is
  'Maps an active connected account to an eligible COA account, atomically transferring an existing mapping only when its current owner belongs to a financial source explicitly superseded by the target source and neither account has active journals or reconciliation history.';
