-- ============================================================
-- MIGRATION 032
-- CONTROLLED CASH FLOW CLASSIFICATION
-- ============================================================
-- Adds one auditable, accounting-role-controlled mutation boundary for
-- explicit cash-flow classification of client ledger accounts.
-- Does not infer classifications and does not mutate journals or balances.

create or replace function classify_cash_flow_account(
  p_client_id uuid,
  p_category_id uuid,
  p_cash_flow_role text,
  p_cash_flow_section text default null
)
returns table (
  category_id uuid,
  cash_flow_role text,
  cash_flow_section text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_category categories%rowtype;
  v_role text := nullif(btrim(p_cash_flow_role), '');
  v_section text := nullif(btrim(p_cash_flow_section), '');
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
    raise exception 'Owner, admin, or bookkeeper access is required to classify cash-flow accounts.';
  end if;

  select c.*
    into v_category
  from categories c
  where c.id = p_category_id
    and c.client_id = p_client_id
  for update;

  if not found then
    raise exception 'Ledger account not found for this client.';
  end if;

  if not v_category.is_active or not v_category.is_posting_account
     or v_category.account_type is null
     or v_category.normal_balance is null then
    raise exception 'Only active classified posting accounts can receive cash-flow classification.';
  end if;

  if v_role is null then
    if v_section is not null then
      raise exception 'An unclassified account cannot have a cash-flow section.';
    end if;
  elsif v_role = 'cash' then
    if v_category.account_type <> 'asset' then
      raise exception 'Only Asset accounts can be classified as cash or cash equivalents.';
    end if;
    if v_section is not null then
      raise exception 'Cash accounts do not receive an operating, investing, or financing section.';
    end if;
  elsif v_role = 'activity' then
    if v_section not in ('operating', 'investing', 'financing') then
      raise exception 'Activity accounts require an operating, investing, or financing section.';
    end if;
  else
    raise exception 'Cash-flow role must be cash, activity, or null.';
  end if;

  update categories
  set cash_flow_role = v_role,
      cash_flow_section = v_section
  where id = v_category.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'cash_flow_account_classified',
    jsonb_build_object(
      'category_id', v_category.id,
      'previous_cash_flow_role', v_category.cash_flow_role,
      'previous_cash_flow_section', v_category.cash_flow_section,
      'cash_flow_role', v_role,
      'cash_flow_section', v_section
    )
  );

  return query
  select v_category.id, v_role, v_section;
end;
$$;

revoke all on function classify_cash_flow_account(uuid,uuid,text,text) from public;
revoke all on function classify_cash_flow_account(uuid,uuid,text,text) from anon;
grant execute on function classify_cash_flow_account(uuid,uuid,text,text) to authenticated;

comment on function classify_cash_flow_account(uuid,uuid,text,text) is
  'Explicitly classifies or clears a client posting account for cash-flow reporting with accounting-role authorization, row locking, schema constraints, and audit history.';
