-- ============================================================
-- BANK ACCOUNT TO CHART-OF-ACCOUNTS MAPPING
--
-- A bank-feed transaction needs an explicit ledger counterpart for the
-- connected financial account before balanced journal posting is safe.
--
-- This migration is intentionally additive. Existing accounts remain
-- unmapped until a user deliberately selects an appropriate client COA
-- account. No mapping is inferred from Plaid account type/subtype.
-- ============================================================

alter table accounts
  add column coa_category_id uuid
    references categories(id) on delete restrict;

create unique index accounts_coa_category_id_unique_idx
  on accounts (coa_category_id)
  where coa_category_id is not null;

comment on column accounts.coa_category_id is
  'Client chart-of-accounts entry representing this connected bank, credit, loan, or other financial account. NULL means the account has not yet been deliberately mapped for journal posting.';

-- ------------------------------------------------------------
-- TENANT / ACCOUNTING SAFETY
--
-- Foreign keys alone cannot guarantee that the selected category belongs
-- to the same client as the Plaid account. Enforce that relationship in a
-- trigger so future API/UI paths cannot accidentally cross client books.
--
-- Global/default categories are deliberately rejected here: a connected
-- financial account is client-specific and must map to a client-specific
-- COA entry.
-- ------------------------------------------------------------

create or replace function validate_account_coa_mapping()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_client_id uuid;
  v_category_client_id uuid;
  v_account_type text;
  v_is_active boolean;
  v_is_posting_account boolean;
begin
  if new.coa_category_id is null then
    return new;
  end if;

  select pi.client_id
    into v_client_id
  from plaid_items pi
  where pi.id = new.plaid_item_id;

  if v_client_id is null then
    raise exception 'Unable to determine the client for this connected account.';
  end if;

  select
    c.client_id,
    c.account_type,
    c.is_active,
    c.is_posting_account
  into
    v_category_client_id,
    v_account_type,
    v_is_active,
    v_is_posting_account
  from categories c
  where c.id = new.coa_category_id;

  if not found then
    raise exception 'Selected chart-of-accounts entry does not exist.';
  end if;

  if v_category_client_id is distinct from v_client_id then
    raise exception 'Connected account must map to a chart-of-accounts entry belonging to the same client.';
  end if;

  if v_account_type not in ('asset', 'liability') then
    raise exception 'Connected financial accounts may only map to asset or liability chart-of-accounts entries.';
  end if;

  if not v_is_active then
    raise exception 'Connected account cannot map to an inactive chart-of-accounts entry.';
  end if;

  if not v_is_posting_account then
    raise exception 'Connected account must map to a posting chart-of-accounts entry.';
  end if;

  return new;
end;
$$;

create trigger validate_account_coa_mapping_trigger
before insert or update of plaid_item_id, coa_category_id
on accounts
for each row
execute function validate_account_coa_mapping();

comment on function validate_account_coa_mapping() is
  'Prevents connected financial accounts from mapping across clients or to non-posting, inactive, or non-balance-sheet COA entries.';
