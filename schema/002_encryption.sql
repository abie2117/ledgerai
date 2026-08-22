-- LedgerAI — 002_encryption.sql
-- Encrypt/decrypt Plaid access tokens at rest using pgcrypto (pgp_sym_*).
--
-- KEY MANAGEMENT: the encryption key itself must never live in the database
-- or in this file. Store it as a Postgres setting injected at deploy time
-- (Supabase: set via `alter database postgres set app.plaid_token_key = '...'`
-- through the dashboard/CLI, backed by your secrets manager — NOT committed
-- to source control). These functions read it via current_setting() so the
-- key never appears in query logs or application code.

-- ============================================================
-- Insert a Plaid item with the access token encrypted server-side.
-- SECURITY DEFINER so it can write even though callers only have the
-- privileges granted by RLS on plaid_items directly.
-- ============================================================
create or replace function insert_plaid_item_encrypted(
  p_client_id uuid,
  p_plaid_item_id text,
  p_access_token text,
  p_institution_name text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_id uuid;
begin
  v_key := current_setting('app.plaid_token_key', true);
  if v_key is null or v_key = '' then
    raise exception 'app.plaid_token_key is not configured';
  end if;

  -- Caller must belong to the firm that owns this client — enforced here
  -- because this function runs as SECURITY DEFINER and bypasses RLS.
  if not exists (
    select 1 from clients c
    join firm_users fu on fu.firm_id = c.firm_id
    where c.id = p_client_id and fu.user_id = auth.uid()
  ) then
    raise exception 'not authorized for this client';
  end if;

  insert into plaid_items (client_id, plaid_item_id, access_token_encrypted, institution_name)
  values (
    p_client_id,
    p_plaid_item_id,
    pgp_sym_encrypt(p_access_token, v_key),
    p_institution_name
  )
  returning id into v_id;

  insert into audit_log (actor_id, client_id, action, detail)
  values (auth.uid(), p_client_id, 'plaid_item_linked', jsonb_build_object('institution', p_institution_name));

  return v_id;
end;
$$;

-- Only authenticated users should be able to call this; RLS/ownership
-- check above still gates which client they can act on.
revoke all on function insert_plaid_item_encrypted from public;
grant execute on function insert_plaid_item_encrypted to authenticated;

-- ============================================================
-- Decrypt an access token. Intended to be called ONLY from trusted
-- server-side code (service-role context), never from the browser —
-- there is no ownership check here because the service role already
-- bypasses RLS everywhere. Keep this function's grant restricted.
-- ============================================================
create or replace function decrypt_plaid_access_token(
  p_encrypted bytea
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
begin
  v_key := current_setting('app.plaid_token_key', true);
  if v_key is null or v_key = '' then
    raise exception 'app.plaid_token_key is not configured';
  end if;

  return pgp_sym_decrypt(p_encrypted, v_key);
end;
$$;

-- Deliberately NOT granted to `authenticated` — only the service role
-- (used by server-side lib/plaid.ts) should ever decrypt a token.
revoke all on function decrypt_plaid_access_token from public;
grant execute on function decrypt_plaid_access_token to service_role;

-- ============================================================
-- Key rotation support (optional, use if you expect to rotate more than
-- once). Adds a version column and a re-encrypt helper.
-- ============================================================
alter table plaid_items add column if not exists token_key_version integer not null default 1;

create or replace function reencrypt_plaid_access_token(
  p_item_id uuid,
  p_old_key text,
  p_new_key text,
  p_new_version integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plaintext text;
begin
  select pgp_sym_decrypt(access_token_encrypted, p_old_key) into v_plaintext
  from plaid_items where id = p_item_id;

  update plaid_items
  set access_token_encrypted = pgp_sym_encrypt(v_plaintext, p_new_key),
      token_key_version = p_new_version
  where id = p_item_id;
end;
$$;

revoke all on function reencrypt_plaid_access_token from public;
grant execute on function reencrypt_plaid_access_token to service_role;
