-- LedgerAI - 005_migrate_legacy_plaid_tokens_to_vault.sql
-- Install the controlled, one-row Phase 3 migration to Vault-backed encryption.

drop function if exists public.reencrypt_plaid_access_token(uuid, text, text, integer);

create or replace function public.reencrypt_plaid_access_token(
  p_item_id uuid
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_encrypted bytea;
  v_plaintext text;
  v_plaid_item_id text;
  v_token_key_version integer;
  v_vault_key text;
  v_secret_count bigint;
begin
  select pi.access_token_encrypted,
         pi.plaid_item_id,
         pi.token_key_version
    into v_encrypted,
         v_plaid_item_id,
         v_token_key_version
  from public.plaid_items pi
  where pi.id = p_item_id
  for update;

  if not found then
    raise exception 'Plaid item does not exist';
  end if;

  if v_token_key_version is distinct from 1 then
    raise exception 'Plaid item is not a legacy token';
  end if;

  if v_plaid_item_id like 'item_test_%' then
    raise exception 'Test Plaid items cannot be migrated';
  end if;

  v_plaintext := pg_catalog.convert_from(
    pg_catalog.decode(
      pg_catalog.convert_from(v_encrypted, 'UTF8'),
      'base64'
    ),
    'UTF8'
  );

  if v_plaintext is null
     or pg_catalog.btrim(v_plaintext) = ''
     or pg_catalog.left(v_plaintext, 7) <> 'access-' then
    raise exception 'Legacy Plaid token is invalid';
  end if;

  select pg_catalog.count(*), pg_catalog.max(ds.decrypted_secret)
    into v_secret_count, v_vault_key
  from vault.decrypted_secrets ds
  where ds.name = 'ledgerai_plaid_token_key';

  if v_secret_count <> 1
     or v_vault_key is null
     or pg_catalog.btrim(v_vault_key) = '' then
    raise exception 'Plaid token encryption key is unavailable';
  end if;

  update public.plaid_items
  set access_token_encrypted = extensions.pgp_sym_encrypt(v_plaintext, v_vault_key),
      token_key_version = 2
  where id = p_item_id;
end;
$$;

revoke all on function public.reencrypt_plaid_access_token(uuid) from public;
revoke all on function public.reencrypt_plaid_access_token(uuid) from anon;
revoke all on function public.reencrypt_plaid_access_token(uuid) from authenticated;
grant execute on function public.reencrypt_plaid_access_token(uuid) to service_role;