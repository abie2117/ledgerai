-- ============================================================
-- MIGRATION 031
-- CASH FLOW CLASSIFICATION FOUNDATION
-- ============================================================
-- Adds explicit cash-flow metadata to the client chart of accounts.
-- This migration does not infer/backfill classifications and does not
-- change journal posting, balances, reconciliation, or existing reports.
-- A future cash-flow statement must use only deliberately classified
-- ledger accounts and must not guess from account names.

alter table categories
  add column if not exists cash_flow_section text,
  add column if not exists cash_flow_role text;

alter table categories
  drop constraint if exists categories_cash_flow_section_check;

alter table categories
  add constraint categories_cash_flow_section_check
  check (
    cash_flow_section is null
    or cash_flow_section in ('operating', 'investing', 'financing')
  );

alter table categories
  drop constraint if exists categories_cash_flow_role_check;

alter table categories
  add constraint categories_cash_flow_role_check
  check (
    cash_flow_role is null
    or cash_flow_role in ('cash', 'activity')
  );

alter table categories
  drop constraint if exists categories_cash_flow_classification_consistency;

alter table categories
  add constraint categories_cash_flow_classification_consistency
  check (
    (cash_flow_role is null and cash_flow_section is null)
    or
    (cash_flow_role = 'cash' and cash_flow_section is null and account_type = 'asset')
    or
    (cash_flow_role = 'activity' and cash_flow_section is not null)
  );

create index if not exists categories_client_cash_flow_idx
  on categories (client_id, cash_flow_role, cash_flow_section)
  where cash_flow_role is not null and is_active = true;

comment on column categories.cash_flow_role is
  'Explicit cash-flow role. cash identifies cash/cash-equivalent asset accounts; activity identifies the non-cash side used to classify cash movements. NULL means not yet classified.';

comment on column categories.cash_flow_section is
  'Explicit cash-flow section for activity accounts: operating, investing, or financing. Cash accounts intentionally have NULL section.';

comment on constraint categories_cash_flow_classification_consistency on categories is
  'Prevents ambiguous cash-flow metadata: cash must be an asset with no section; activity must have an explicit section; NULL/NULL remains unclassified.';
