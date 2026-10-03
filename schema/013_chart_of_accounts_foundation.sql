-- ============================================================
-- CHART OF ACCOUNTS ACCOUNTING FOUNDATION
--
-- Extend the existing categories table into an accounting-capable chart
-- without changing current categorization behavior or existing rows.
-- Existing categories remain valid with NULL accounting metadata until
-- they are deliberately classified.
-- ============================================================

alter table categories
  add column account_type text,
  add column normal_balance text,
  add column is_posting_account boolean not null default true,
  add column is_active boolean not null default true;

alter table categories
  add constraint categories_account_type_check
    check (
      account_type is null
      or account_type in (
        'asset',
        'liability',
        'equity',
        'revenue',
        'expense'
      )
    ),
  add constraint categories_normal_balance_check
    check (
      normal_balance is null
      or normal_balance in ('debit', 'credit')
    ),
  add constraint categories_accounting_classification_consistency
    check (
      (account_type is null and normal_balance is null)
      or
      (
        account_type is not null
        and normal_balance is not null
        and (
          (account_type in ('asset', 'expense') and normal_balance = 'debit')
          or
          (account_type in ('liability', 'equity', 'revenue') and normal_balance = 'credit')
        )
      )
    );

create index categories_client_account_type_idx
  on categories (client_id, account_type)
  where account_type is not null and is_active = true;

create index categories_firm_account_type_idx
  on categories (firm_id, account_type)
  where account_type is not null and is_active = true;

comment on column categories.account_type is
  'Accounting classification for this chart-of-accounts entry: asset, liability, equity, revenue, or expense. NULL means the legacy category has not yet been accounting-classified.';

comment on column categories.normal_balance is
  'Normal accounting balance derived from account type: debit for asset/expense; credit for liability/equity/revenue.';

comment on column categories.is_posting_account is
  'Whether journal lines may eventually post directly to this account. Parent/header accounts can later be marked false.';

comment on column categories.is_active is
  'Whether this chart-of-accounts entry is available for new bookkeeping activity. Inactive accounts remain preserved for history.';
