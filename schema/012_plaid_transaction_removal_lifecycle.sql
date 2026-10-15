-- ============================================================
-- PLAID TRANSACTION REMOVAL LIFECYCLE
--
-- Preserve bank-feed records that Plaid later reports as removed.
-- Physical deletion can destroy bookkeeping evidence and can conflict
-- with confirmed duplicate links. Application financial logic excludes
-- rows only after this provider-removal timestamp is set.
-- ============================================================

alter table transactions
  add column plaid_removed_at timestamptz;

create index transactions_plaid_removed_at_idx
  on transactions (client_id, plaid_removed_at)
  where plaid_removed_at is not null;

comment on column transactions.plaid_removed_at is
  'Timestamp when Plaid reported this bank-feed transaction as removed. The row is preserved for audit history and excluded from active financial calculations.';
