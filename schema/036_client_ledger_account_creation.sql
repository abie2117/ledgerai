-- Create client-specific posting accounts without changing shared categories.
create or replace function create_client_ledger_account(
  p_client_id uuid, p_name text, p_coa_code text, p_account_type text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text := nullif(btrim(p_name), '');
  v_code text := nullif(btrim(p_coa_code), '');
  v_category_id uuid;
  v_balance text;
begin
  if v_user_id is null then raise exception 'Authentication required.'; end if;
  if not exists (
    select 1 from clients c join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = v_user_id
      and fu.role in ('owner', 'admin', 'bookkeeper')
  ) then raise exception 'Owner, admin, or bookkeeper access is required to create ledger accounts.'; end if;
  if v_name is null or length(v_name) > 120 or v_code is null or length(v_code) > 30
     or p_account_type is null
     or p_account_type not in ('asset', 'liability', 'equity', 'revenue', 'expense') then
    raise exception 'A name (up to 120 characters), code (up to 30 characters), and valid account type are required.';
  end if;
  -- Serialize this operation per client before checking existing codes/names.
  perform c.id from clients c where c.id = p_client_id for update;
  if exists (select 1 from categories c where c.client_id = p_client_id
    and (lower(btrim(c.coa_code)) = lower(v_code) or lower(btrim(c.name)) = lower(v_name))) then
    raise exception 'This client already has an account with that code or name. Review the existing account before creating another.';
  end if;
  v_balance := case when p_account_type in ('asset', 'expense') then 'debit' else 'credit' end;
  insert into categories (client_id, name, coa_code, account_type, normal_balance,
    is_active, is_posting_account, is_default)
  values (p_client_id, v_name, v_code, p_account_type, v_balance, true, true, false)
  returning id into v_category_id;
  insert into audit_log (actor_id, client_id, action, detail)
  values (v_user_id, p_client_id, 'client_ledger_account_created', jsonb_build_object(
    'category_id', v_category_id, 'name', v_name, 'coa_code', v_code,
    'account_type', p_account_type, 'normal_balance', v_balance,
    'is_active', true, 'is_posting_account', true));
  return v_category_id;
end;
$$;
revoke all on function create_client_ledger_account(uuid,text,text,text) from public, anon;
grant execute on function create_client_ledger_account(uuid,text,text,text) to authenticated;
