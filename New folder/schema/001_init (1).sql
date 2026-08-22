-- LedgerAI — initial schema
-- Run via: supabase migration new init  (then paste this in), or supabase db push

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ============================================================
-- FIRMS & USERS
-- A "firm" is the paying customer (a CPA/bookkeeping practice or
-- a solo bookkeeper). firm_users links Supabase auth.users to a firm.
-- ============================================================
create table firms (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  tier text not null default 'starter' check (tier in ('starter', 'growth', 'firm_scale')),
  created_at timestamptz not null default now()
);

create table firm_users (
  id uuid primary key default uuid_generate_v4(),
  firm_id uuid not null references firms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'bookkeeper' check (role in ('owner', 'admin', 'bookkeeper', 'read_only')),
  created_at timestamptz not null default now(),
  unique (firm_id, user_id)
);

-- ============================================================
-- CLIENTS
-- A client is one of the firm's end customers (a small business
-- whose books the firm manages). All financial data hangs off this.
-- ============================================================
create table clients (
  id uuid primary key default uuid_generate_v4(),
  firm_id uuid not null references firms(id) on delete cascade,
  business_name text not null,
  entity_type text,               -- e.g. LLC, sole prop — informs default chart of accounts
  fiscal_year_start date,
  status text not null default 'active' check (status in ('active', 'paused', 'offboarded')),
  created_at timestamptz not null default now()
);

-- ============================================================
-- PLAID CONNECTIONS
-- access_token is encrypted at rest (pgcrypto) — never store plaintext.
-- ============================================================
create table plaid_items (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  plaid_item_id text not null unique,
  access_token_encrypted bytea not null,
  institution_name text,
  status text not null default 'active' check (status in ('active', 'error', 'revoked')),
  cursor text,                     -- Plaid /transactions/sync cursor for incremental pulls
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);

create table accounts (
  id uuid primary key default uuid_generate_v4(),
  plaid_item_id uuid not null references plaid_items(id) on delete cascade,
  plaid_account_id text not null unique,
  name text not null,
  mask text,
  type text,                       -- depository, credit, loan, etc.
  subtype text,                    -- checking, savings, credit card, etc.
  created_at timestamptz not null default now()
);

-- ============================================================
-- CHART OF ACCOUNTS / CATEGORIES
-- client_id is null for firm-level or global default categories;
-- populated once a client customizes their own chart.
-- ============================================================
create table categories (
  id uuid primary key default uuid_generate_v4(),
  firm_id uuid references firms(id) on delete cascade,
  client_id uuid references clients(id) on delete cascade,
  name text not null,
  coa_code text,                   -- chart-of-accounts code, e.g. "6100"
  parent_id uuid references categories(id),
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- ============================================================
-- TRANSACTIONS
-- ============================================================
create table transactions (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  plaid_transaction_id text not null unique,
  posted_date date not null,
  amount numeric(14,2) not null,
  merchant_name text,
  raw_plaid_category text,
  ai_category_id uuid references categories(id),
  ai_confidence numeric(4,3),      -- 0.000–1.000
  status text not null default 'pending_review' check (status in ('pending_review', 'confirmed', 'flagged')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on transactions (client_id, posted_date);
create index on transactions (status);

-- ============================================================
-- CORRECTION MEMORY
-- Every time a bookkeeper overrides the AI's category, we log it here.
-- This table (plus category_mapping_rules below) is the compounding
-- data asset that makes LedgerAI stickier the longer a client stays.
-- ============================================================
create table category_corrections (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  transaction_id uuid not null references transactions(id) on delete cascade,
  from_category_id uuid references categories(id),
  to_category_id uuid not null references categories(id),
  corrected_by uuid not null references auth.users(id),
  corrected_at timestamptz not null default now()
);

-- Learned merchant → category rules, built up from corrections over time.
-- This is what "compounds" per client and is expensive for a client to
-- walk away from — it's not in their books, it's in LedgerAI.
create table category_mapping_rules (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  merchant_pattern text not null,        -- normalized merchant name or regex
  category_id uuid not null references categories(id),
  confidence_score numeric(4,3) not null default 0.5,
  hit_count integer not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (client_id, merchant_pattern)
);

-- ============================================================
-- RECONCILIATION
-- ============================================================
create table reconciliations (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed', 'needs_attention')),
  summary jsonb,                   -- totals, discrepancies, category breakdown
  reconciled_by uuid references auth.users(id),
  reconciled_at timestamptz,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ANOMALY / FRAUD FLAGS (v2 feature, schema in place from day one)
-- ============================================================
create table anomalies (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id) on delete cascade,
  transaction_id uuid references transactions(id) on delete cascade,
  type text not null,              -- e.g. 'duplicate', 'unusual_amount', 'new_vendor_large_spend'
  severity text not null default 'low' check (severity in ('low', 'medium', 'high')),
  description text,
  status text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  detected_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- ============================================================
-- AUDIT LOG (compliance — who did what, when)
-- ============================================================
create table audit_log (
  id uuid primary key default uuid_generate_v4(),
  actor_id uuid references auth.users(id),
  client_id uuid references clients(id) on delete cascade,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Core rule: a user can only touch data belonging to clients under
-- a firm they belong to (via firm_users).
-- ============================================================
alter table firms enable row level security;
alter table firm_users enable row level security;
alter table clients enable row level security;
alter table plaid_items enable row level security;
alter table accounts enable row level security;
alter table categories enable row level security;
alter table transactions enable row level security;
alter table category_corrections enable row level security;
alter table category_mapping_rules enable row level security;
alter table reconciliations enable row level security;
alter table anomalies enable row level security;
alter table audit_log enable row level security;

-- Helper: firms the current user belongs to
create or replace view my_firms as
  select firm_id from firm_users where user_id = auth.uid();

create policy "firm members can view their firm" on firms
  for select using (id in (select firm_id from my_firms));

create policy "firm members can view firm_users in their firm" on firm_users
  for select using (firm_id in (select firm_id from my_firms));

create policy "firm members can access their clients" on clients
  for all using (firm_id in (select firm_id from my_firms));

create policy "firm members can access plaid_items for their clients" on plaid_items
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can access accounts for their clients" on accounts
  for all using (plaid_item_id in (
    select id from plaid_items where client_id in (
      select id from clients where firm_id in (select firm_id from my_firms)
    )
  ));

create policy "firm members can access categories" on categories
  for all using (
    firm_id in (select firm_id from my_firms)
    or client_id in (select id from clients where firm_id in (select firm_id from my_firms))
  );

create policy "firm members can access transactions for their clients" on transactions
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can access corrections for their clients" on category_corrections
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can access mapping rules for their clients" on category_mapping_rules
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can access reconciliations for their clients" on reconciliations
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can access anomalies for their clients" on anomalies
  for all using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));

create policy "firm members can view audit_log for their clients" on audit_log
  for select using (client_id in (select id from clients where firm_id in (select firm_id from my_firms)));
