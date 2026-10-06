-- Authoritative-source boundaries for recurring evidence. Historical rows are preserved.
create or replace function lock_active_recurring_account(p_client_id uuid, p_account_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_source plaid_items%rowtype;
begin
  select pi.* into v_source from plaid_items pi join accounts a on a.plaid_item_id = pi.id
    where a.id = p_account_id and pi.client_id = p_client_id for update of pi;
  if not found then raise exception 'Account does not belong to the selected client.'; end if;
  perform a.id from accounts a where a.id = p_account_id and a.plaid_item_id = v_source.id for update;
  if not found then raise exception 'Connected account changed. Reload recurring activity.'; end if;
  if v_source.status is distinct from 'active' or v_source.financial_source_status is distinct from 'active' then
    raise exception 'Recurring evidence requires a provider-active, financially active source.';
  end if;
end;
$$;
-- Internal helper only; callable by the owning protected functions.
revoke all on function lock_active_recurring_account(uuid,uuid) from public, anon, authenticated, service_role;

create or replace function upsert_detected_recurring_candidate(
  p_client_id uuid,
  p_account_id uuid,
  p_merchant_pattern text,
  p_cadence text,
  p_expected_amount numeric,
  p_amount_tolerance numeric,
  p_occurrence_count integer,
  p_first_occurrence_date date,
  p_last_occurrence_date date,
  p_next_expected_date date,
  p_confidence_score numeric,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate_id uuid;
  v_merchant_pattern text;
  v_vendor_id uuid;
begin
  if p_cadence not in ('weekly', 'monthly', 'quarterly', 'annual') then
    raise exception 'Unsupported recurring cadence.';
  end if;

  if p_occurrence_count < 2 then
    raise exception 'At least two occurrences are required for recurring evidence.';
  end if;

  if p_first_occurrence_date is null
     or p_last_occurrence_date is null
     or p_first_occurrence_date > p_last_occurrence_date then
    raise exception 'Recurring occurrence dates are invalid.';
  end if;

  if p_confidence_score is null
     or p_confidence_score < 0
     or p_confidence_score > 1 then
    raise exception 'Recurring confidence must be between zero and one.';
  end if;

  if coalesce(p_amount_tolerance, 0) < 0 then
    raise exception 'Amount tolerance cannot be negative.';
  end if;

  v_merchant_pattern := normalize_vendor_merchant(p_merchant_pattern);

  if v_merchant_pattern is null then
    raise exception 'A normalized merchant pattern is required.';
  end if;

  if not exists (
    select 1
    from accounts a
    join plaid_items pi on pi.id = a.plaid_item_id
    where a.id = p_account_id
      and pi.client_id = p_client_id
  ) then
    raise exception 'Account does not belong to the selected client.';
  end if;

  perform lock_active_recurring_account(p_client_id, p_account_id);

  select va.vendor_id
    into v_vendor_id
  from vendor_aliases va
  join vendors v on v.id = va.vendor_id
  where va.client_id = p_client_id
    and va.merchant_pattern = v_merchant_pattern
    and v.client_id = p_client_id
    and v.status = 'active'
  limit 1;

  insert into recurring_transaction_candidates (
    client_id,
    account_id,
    vendor_id,
    merchant_pattern,
    cadence,
    expected_amount,
    amount_tolerance,
    occurrence_count,
    first_occurrence_date,
    last_occurrence_date,
    next_expected_date,
    confidence_score,
    evidence,
    status
  )
  values (
    p_client_id,
    p_account_id,
    v_vendor_id,
    v_merchant_pattern,
    p_cadence,
    case when p_expected_amount is null then null else round(p_expected_amount, 2) end,
    round(coalesce(p_amount_tolerance, 0), 2),
    p_occurrence_count,
    p_first_occurrence_date,
    p_last_occurrence_date,
    p_next_expected_date,
    p_confidence_score,
    coalesce(p_evidence, '{}'::jsonb),
    'detected'
  )
  on conflict (client_id, account_id, merchant_pattern, cadence)
  do update set
    vendor_id = coalesce(
      recurring_transaction_candidates.vendor_id,
      excluded.vendor_id
    ),
    expected_amount = excluded.expected_amount,
    amount_tolerance = excluded.amount_tolerance,
    occurrence_count = excluded.occurrence_count,
    first_occurrence_date = excluded.first_occurrence_date,
    last_occurrence_date = excluded.last_occurrence_date,
    next_expected_date = excluded.next_expected_date,
    confidence_score = excluded.confidence_score,
    evidence = excluded.evidence,
    updated_at = now()
  returning id into v_candidate_id;

  return v_candidate_id;
end;
$$;

create or replace function create_or_link_vendor(
  p_client_id uuid,
  p_display_name text,
  p_merchant_pattern text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_normalized_name text;
  v_merchant_pattern text;
  v_vendor_id uuid;
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
    raise exception 'User is not authorized to manage vendors for this client.';
  end if;

  v_normalized_name := normalize_vendor_merchant(p_display_name);
  v_merchant_pattern := normalize_vendor_merchant(p_merchant_pattern);

  if v_normalized_name is null or v_merchant_pattern is null then
    raise exception 'Vendor name and merchant pattern are required.';
  end if;

  -- Lock providers first, then accounts, before selecting actionable evidence.
  perform pi.id from plaid_items pi where pi.client_id = p_client_id and pi.id in (
    select a.plaid_item_id from accounts a join recurring_transaction_candidates r on r.account_id = a.id
    where r.client_id = p_client_id and r.merchant_pattern = v_merchant_pattern and r.status <> 'dismissed'
  ) order by pi.id for update;
  perform a.id from accounts a join plaid_items pi on pi.id = a.plaid_item_id
    where pi.client_id = p_client_id and a.id in (
      select r.account_id from recurring_transaction_candidates r where r.client_id = p_client_id
        and r.merchant_pattern = v_merchant_pattern and r.status <> 'dismissed'
    ) order by a.id for update of a;
  if not exists (
    select 1 from recurring_transaction_candidates r join accounts a on a.id = r.account_id
    join plaid_items pi on pi.id = a.plaid_item_id
    where r.client_id = p_client_id and pi.client_id = p_client_id
      and r.merchant_pattern = v_merchant_pattern and r.status <> 'dismissed'
      and pi.status = 'active' and pi.financial_source_status = 'active'
  ) then raise exception 'An active-source recurring candidate is required to link this merchant.'; end if;

  insert into vendors (
    client_id,
    display_name,
    normalized_name,
    created_by
  )
  values (
    p_client_id,
    btrim(p_display_name),
    v_normalized_name,
    v_user_id
  )
  on conflict (client_id, normalized_name)
  do update set
    display_name = excluded.display_name,
    status = 'active',
    updated_at = now()
  returning id into v_vendor_id;

  insert into vendor_aliases (
    client_id,
    vendor_id,
    merchant_pattern,
    created_by
  )
  values (
    p_client_id,
    v_vendor_id,
    v_merchant_pattern,
    v_user_id
  )
  on conflict (client_id, merchant_pattern)
  do update set
    vendor_id = excluded.vendor_id;

  update recurring_transaction_candidates
  set vendor_id = v_vendor_id,
      updated_at = now()
  where client_id = p_client_id
    and merchant_pattern = v_merchant_pattern
    and status <> 'dismissed'
    and account_id in (
      select a.id from accounts a join plaid_items pi on pi.id = a.plaid_item_id
      where pi.client_id = p_client_id and pi.status = 'active'
        and pi.financial_source_status = 'active'
    );

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    'vendor_identity_linked',
    jsonb_build_object(
      'vendor_id', v_vendor_id,
      'merchant_pattern', v_merchant_pattern
    )
  );

  return v_vendor_id;
end;
$$;

create or replace function review_recurring_transaction_candidate(
  p_candidate_id uuid,
  p_client_id uuid,
  p_action text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_candidate recurring_transaction_candidates%rowtype;
  v_status text;
  v_account_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required.';
  end if;

  if p_action not in ('confirm', 'dismiss') then
    raise exception 'Recurring review action must be confirm or dismiss.';
  end if;

  if not exists (
    select 1
    from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then
    raise exception 'User is not authorized to review recurring evidence for this client.';
  end if;

  select account_id into v_account_id from recurring_transaction_candidates
  where id = p_candidate_id and client_id = p_client_id;
  if not found then raise exception 'Recurring candidate not found.'; end if;
  perform lock_active_recurring_account(p_client_id, v_account_id);

  select *
    into v_candidate
  from recurring_transaction_candidates
  where id = p_candidate_id
    and client_id = p_client_id
  for update;

  if not found then
    raise exception 'Recurring candidate not found.';
  end if;

  if v_candidate.account_id is distinct from v_account_id then
    raise exception 'Candidate account changed. Reload recurring activity.';
  end if;

  if v_candidate.status <> 'detected' then
    raise exception 'Only detected recurring candidates can be reviewed.';
  end if;

  v_status := case when p_action = 'confirm' then 'confirmed' else 'dismissed' end;

  update recurring_transaction_candidates
  set status = v_status,
      reviewed_by = v_user_id,
      reviewed_at = now(),
      updated_at = now()
  where id = v_candidate.id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (
    v_user_id,
    p_client_id,
    case
      when p_action = 'confirm' then 'recurring_candidate_confirmed'
      else 'recurring_candidate_dismissed'
    end,
    jsonb_build_object(
      'candidate_id', v_candidate.id,
      'account_id', v_candidate.account_id,
      'vendor_id', v_candidate.vendor_id,
      'merchant_pattern', v_candidate.merchant_pattern,
      'cadence', v_candidate.cadence
    )
  );

  return v_candidate.id;
end;
$$;

revoke all on function upsert_detected_recurring_candidate(
  uuid, uuid, text, text, numeric, numeric, integer, date, date, date, numeric, jsonb
) from public, anon, authenticated;
grant execute on function upsert_detected_recurring_candidate(
  uuid, uuid, text, text, numeric, numeric, integer, date, date, date, numeric, jsonb
) to service_role;

revoke all on function create_or_link_vendor(uuid, text, text)
  from public, anon;
grant execute on function create_or_link_vendor(uuid, text, text)
  to authenticated;

revoke all on function review_recurring_transaction_candidate(uuid, uuid, text)
  from public, anon;
grant execute on function review_recurring_transaction_candidate(uuid, uuid, text)
  to authenticated;

