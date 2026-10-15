-- LedgerAI - 006_remove_legacy_plaid_token_migration_rpc.sql
-- Retire the temporary legacy Plaid token migration RPC after all live Items use Vault-backed v2 storage.

drop function if exists public.reencrypt_plaid_access_token(uuid);
