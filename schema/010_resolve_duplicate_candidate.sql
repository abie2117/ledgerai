-- ============================================================
-- ATOMIC DUPLICATE RESOLUTION
--
-- A confirmed duplicate changes bookkeeping inclusion, resolves the
-- evidence candidate, and writes an audit event as one database
-- transaction. The duplicate bank-feed row itself is preserved.
-- ============================================================

create or replace function resolve_duplicate_candidate(
  p_candidate_id uuid,
  p_client_id uuid,
  p_duplicate_transaction_id uuid
)
returns table (
  candidate_id uuid,
  duplicate_transaction_id uuid,
  retained_transaction_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_candidate duplicate_candidates%rowtype;
  v_retained_transaction_id uuid;
  v_pair_count integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
  ) then
    raise exception 'Client is not authorized';
  end if;

  select *
  into v_candidate
  from duplicate_candidates
  where id = p_candidate_id
    and client_id = p_client_id
  for update;

  if not found then
    raise exception 'Duplicate candidate not found';
  end if;

  if v_candidate.status <> 'open' then
    raise exception 'Duplicate candidate is no longer open';
  end if;

  if p_duplicate_transaction_id = v_candidate.transaction_a_id then
    v_retained_transaction_id := v_candidate.transaction_b_id;
  elsif p_duplicate_transaction_id = v_candidate.transaction_b_id then
    v_retained_transaction_id := v_candidate.transaction_a_id;
  else
    raise exception 'Selected transaction is not part of this duplicate candidate';
  end if;

  select count(*)
  into v_pair_count
  from transactions
  where client_id = p_client_id
    and id in (
      v_candidate.transaction_a_id,
      v_candidate.transaction_b_id
    );

  if v_pair_count <> 2 then
    raise exception 'Duplicate candidate transactions do not belong to the selected client';
  end if;

  if exists (
    select 1
    from transactions
    where id = p_duplicate_transaction_id
      and duplicate_of_transaction_id is not null
  ) then
    raise exception 'Selected transaction is already resolved as a duplicate';
  end if;

  if exists (
    select 1
    from transactions
    where id = v_retained_transaction_id
      and duplicate_of_transaction_id is not null
  ) then
    raise exception 'The transaction selected to retain is already resolved as a duplicate';
  end if;

  update transactions
  set
    duplicate_of_transaction_id = v_retained_transaction_id,
    duplicate_resolved_at = now(),
    duplicate_resolved_by = v_user_id,
    updated_at = now()
  where id = p_duplicate_transaction_id
    and client_id = p_client_id;

  update duplicate_candidates
  set
    status = 'resolved',
    resolved_at = now(),
    resolved_by = v_user_id
  where id = p_candidate_id
    and client_id = p_client_id
    and status = 'open';

  insert into audit_log (
    actor_id,
    client_id,
    action,
    detail
  )
  values (
    v_user_id,
    p_client_id,
    'duplicate_confirmed',
    jsonb_build_object(
      'candidate_id', p_candidate_id,
      'duplicate_transaction_id', p_duplicate_transaction_id,
      'retained_transaction_id', v_retained_transaction_id
    )
  );

  return query
  select
    p_candidate_id,
    p_duplicate_transaction_id,
    v_retained_transaction_id;
end;
$$;

revoke all on function resolve_duplicate_candidate(uuid, uuid, uuid) from public;
grant execute on function resolve_duplicate_candidate(uuid, uuid, uuid) to authenticated;

comment on function resolve_duplicate_candidate(uuid, uuid, uuid) is
  'Atomically confirms one side of an open duplicate candidate as the excluded duplicate copy, preserves the retained bank transaction, resolves the candidate, and writes an audit event.';
