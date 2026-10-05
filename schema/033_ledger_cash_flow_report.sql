-- ============================================================
-- MIGRATION 033
-- LEDGER-DERIVED CASH FLOW REPORTING BOUNDARY
-- ============================================================
-- Uses posted/reversed journal history plus explicit Migration 031
-- classifications. Drafts are excluded. No classification is inferred.

create or replace function get_cash_flow_report(
  p_client_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  beginning_cash numeric,
  operating_cash_flow numeric,
  investing_cash_flow numeric,
  financing_cash_flow numeric,
  unclassified_cash_flow numeric,
  net_cash_change numeric,
  ending_cash numeric,
  reconciliation_difference numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_beginning_cash numeric := 0;
  v_operating numeric := 0;
  v_investing numeric := 0;
  v_financing numeric := 0;
  v_unclassified numeric := 0;
  v_net_change numeric := 0;
  v_ending_cash numeric := 0;
  v_reconciliation_difference numeric := 0;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if not exists (
    select 1 from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = v_user_id
  ) then
    raise exception 'User is not authorized to view reports for this client.';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Cash-flow report requires a start date and end date.';
  end if;
  if p_start_date > p_end_date then
    raise exception 'Cash-flow report start date cannot be after end date.';
  end if;

  select coalesce(sum(jl.debit - jl.credit), 0)
  into v_beginning_cash
  from journal_entries je
  join journal_lines jl on jl.journal_entry_id = je.id
  join categories c on c.id = jl.category_id
  where je.client_id = p_client_id
    and je.status in ('posted', 'reversed')
    and je.entry_date < p_start_date
    and c.client_id = p_client_id
    and c.cash_flow_role = 'cash';

  with period_entries as (
    select je.id
    from journal_entries je
    where je.client_id = p_client_id
      and je.status in ('posted', 'reversed')
      and je.entry_date >= p_start_date
      and je.entry_date <= p_end_date
  ),
  cash_by_entry as (
    select pe.id as journal_entry_id,
      coalesce(sum(case when c.cash_flow_role = 'cash'
        then jl.debit - jl.credit else 0 end), 0) as cash_movement
    from period_entries pe
    join journal_lines jl on jl.journal_entry_id = pe.id
    join categories c on c.id = jl.category_id
    group by pe.id
  ),
  counterpart_lines as (
    select cb.journal_entry_id, cb.cash_movement,
      c.cash_flow_role, c.cash_flow_section,
      abs(jl.debit - jl.credit) as line_weight
    from cash_by_entry cb
    join journal_lines jl on jl.journal_entry_id = cb.journal_entry_id
    join categories c on c.id = jl.category_id
    where cb.cash_movement <> 0
      and coalesce(c.cash_flow_role, '') <> 'cash'
  ),
  weighted_entries as (
    select journal_entry_id, max(cash_movement) as cash_movement,
      sum(line_weight) as total_weight
    from counterpart_lines
    group by journal_entry_id
  ),
  allocations as (
    select cl.journal_entry_id,
      case when cl.cash_flow_role = 'activity'
        and cl.cash_flow_section in ('operating','investing','financing')
        then cl.cash_flow_section else 'unclassified' end as section,
      case when we.total_weight > 0
        then we.cash_movement * (cl.line_weight / we.total_weight)
        else 0 end as allocated_cash
    from counterpart_lines cl
    join weighted_entries we on we.journal_entry_id = cl.journal_entry_id
  ),
  orphan_cash_movements as (
    select cb.journal_entry_id, 'unclassified'::text as section,
      cb.cash_movement as allocated_cash
    from cash_by_entry cb
    where cb.cash_movement <> 0
      and not exists (
        select 1 from counterpart_lines cl
        where cl.journal_entry_id = cb.journal_entry_id
      )
  ),
  all_allocations as (
    select section, allocated_cash from allocations
    union all
    select section, allocated_cash from orphan_cash_movements
  )
  select
    coalesce(sum(allocated_cash) filter (where section='operating'),0),
    coalesce(sum(allocated_cash) filter (where section='investing'),0),
    coalesce(sum(allocated_cash) filter (where section='financing'),0),
    coalesce(sum(allocated_cash) filter (where section='unclassified'),0)
  into v_operating, v_investing, v_financing, v_unclassified
  from all_allocations;

  select coalesce(sum(jl.debit - jl.credit),0)
  into v_net_change
  from journal_entries je
  join journal_lines jl on jl.journal_entry_id=je.id
  join categories c on c.id=jl.category_id
  where je.client_id=p_client_id
    and je.status in ('posted','reversed')
    and je.entry_date>=p_start_date and je.entry_date<=p_end_date
    and c.client_id=p_client_id and c.cash_flow_role='cash';

  select coalesce(sum(jl.debit - jl.credit),0)
  into v_ending_cash
  from journal_entries je
  join journal_lines jl on jl.journal_entry_id=je.id
  join categories c on c.id=jl.category_id
  where je.client_id=p_client_id
    and je.status in ('posted','reversed')
    and je.entry_date<=p_end_date
    and c.client_id=p_client_id and c.cash_flow_role='cash';

  v_reconciliation_difference := v_ending_cash -
    (v_beginning_cash + v_operating + v_investing + v_financing + v_unclassified);

  return query select
    round(v_beginning_cash,2), round(v_operating,2), round(v_investing,2),
    round(v_financing,2), round(v_unclassified,2), round(v_net_change,2),
    round(v_ending_cash,2), round(v_reconciliation_difference,2);
end;
$$;

revoke all on function get_cash_flow_report(uuid,date,date) from public;
revoke all on function get_cash_flow_report(uuid,date,date) from anon;
grant execute on function get_cash_flow_report(uuid,date,date) to authenticated;

comment on function get_cash_flow_report(uuid,date,date) is
  'Returns a ledger-derived cash-flow summary using explicitly classified cash and activity accounts. Cash-to-cash transfers net to zero, unclassified counterpart activity remains visible, drafts are excluded, and beginning cash plus classified and unclassified movement reconciles to ending cash.';
