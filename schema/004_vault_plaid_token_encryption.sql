-- LedgerAI - 004_vault_plaid_token_encryption.sql
-- Move v2 Plaid token encryption to the single Supabase Vault secret.
-- Existing v1 rows remain unchanged until explicitly re-encrypted later.

-- ============================================================
-- Insert or refresh a Plaid item with its access token encrypted
-- using the Vault-managed key.
-- ============================================================
create or replace function public.insert_plaid_item_encrypted(
  p_client_id uuid,
  p_plaid_item_id text,
  p_access_token text,
  p_institution_name text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_secret_count bigint;
  v_id uuid;
  v_existing_client_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if not exists (
    select 1
    from public.clients c
    join public.firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id
      and fu.user_id = auth.uid()
  ) then
    raise exception 'not authorized for this client';
  end if;

  select pg_catalog.count(*), pg_catalog.max(ds.decrypted_secret)
    into v_secret_count, v_key
  from vault.decrypted_secrets ds
  where ds.name = 'ledgerai_plaid_token_key';

  if v_secret_count <> 1
     or v_key is null
     or pg_catalog.btrim(v_key) = '' then
    raise exception 'Plaid token encryption key is unavailable';
  end if;

  -- DO NOTHING makes the unique-item claim atomic. A conflicting row is
  -- then locked before its owning client is checked or updated.
  insert into public.plaid_items (
    client_id,
    plaid_item_id,
    access_token_encrypted,
    institution_name,
    token_key_version
  )
  values (
    p_client_id,
    p_plaid_item_id,
    extensions.pgp_sym_encrypt(p_access_token, v_key),
    p_institution_name,
    2
  )
  on conflict (plaid_item_id) do nothing
  returning id into v_id;

  if v_id is not null then
    insert into public.audit_log (actor_id, client_id, action, detail)
    values (
      auth.uid(),
      p_client_id,
      'plaid_item_linked',
      pg_catalog.jsonb_build_object('institution', p_institution_name)
    );
    return v_id;
  end if;

  select pi.id, pi.client_id
    into v_id, v_existing_client_id
  from public.plaid_items pi
  where pi.plaid_item_id = p_plaid_item_id
  for update;

  if not found then
    raise exception 'Plaid item conflict could not be resolved';
  end if;

  if v_existing_client_id is distinct from p_client_id then
    raise exception 'Plaid item is already linked to another client';
  end if;

  update public.plaid_items
  set access_token_encrypted = extensions.pgp_sym_encrypt(p_access_token, v_key),
      institution_name = p_institution_name,
      token_key_version = 2
  where id = v_id;

  insert into public.audit_log (actor_id, client_id, action, detail)
  values (
    auth.uid(),
    p_client_id,
    'plaid_item_linked',
    pg_catalog.jsonb_build_object('institution', p_institution_name)
  );

  return v_id;
end;
$$;

revoke all on function public.insert_plaid_item_encrypted(uuid, text, text, text) from public;
revoke all on function public.insert_plaid_item_encrypted(uuid, text, text, text) from anon;
grant execute on function public.insert_plaid_item_encrypted(uuid, text, text, text) to authenticated;

-- ============================================================
-- Decrypt a Plaid access token for trusted service-role code only.
-- ============================================================
create or replace function public.decrypt_plaid_access_token(
  p_encrypted bytea
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_secret_count bigint;
begin
  select pg_catalog.count(*), pg_catalog.max(ds.decrypted_secret)
    into v_secret_count, v_key
  from vault.decrypted_secrets ds
  where ds.name = 'ledgerai_plaid_token_key';

  if v_secret_count <> 1
     or v_key is null
     or pg_catalog.btrim(v_key) = '' then
    raise exception 'Plaid token encryption key is unavailable';
  end if;

  return extensions.pgp_sym_decrypt(p_encrypted, v_key);
end;
$$;

revoke all on function public.decrypt_plaid_access_token(bytea) from public;
revoke all on function public.decrypt_plaid_access_token(bytea) from anon;
revoke all on function public.decrypt_plaid_access_token(bytea) from authenticated;
grant execute on function public.decrypt_plaid_access_token(bytea) to service_role;
