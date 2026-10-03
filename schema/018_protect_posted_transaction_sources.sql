-- ============================================================
-- MIGRATION 018
-- PROTECT POSTED TRANSACTION SOURCES
--
-- A posted journal is accounting evidence. Until LedgerAI has a controlled
-- reversal/repost workflow, bookkeeping-significant fields on the source
-- transaction must not change silently after posting.
--
-- This guard does not affect unposted transactions.
-- ============================================================

create or replace function protect_posted_transaction_source()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1
    from journal_entries je
    where je.transaction_id = old.id
      and je.status = 'posted'
      and je.reversal_of_journal_entry_id is null
  ) then
    if new.client_id is distinct from old.client_id
       or new.account_id is distinct from old.account_id
       or new.posted_date is distinct from old.posted_date
       or new.amount is distinct from old.amount
       or new.merchant_name is distinct from old.merchant_name
       or new.ai_category_id is distinct from old.ai_category_id
       or new.category is distinct from old.category
       or new.duplicate_of_transaction_id is distinct from old.duplicate_of_transaction_id
       or new.plaid_removed_at is distinct from old.plaid_removed_at then
      raise exception
        'Posted transaction cannot be changed until its journal entry is reversed.';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists protect_posted_transaction_source_trigger
  on transactions;

create trigger protect_posted_transaction_source_trigger
before update of
  client_id,
  account_id,
  posted_date,
  amount,
  merchant_name,
  ai_category_id,
  category,
  duplicate_of_transaction_id,
  plaid_removed_at
on transactions
for each row
execute function protect_posted_transaction_source();

comment on function protect_posted_transaction_source() is
  'Prevents bookkeeping-significant source fields from diverging from an active posted journal. A later controlled reversal/repost workflow is required before those fields may change.';

comment on trigger protect_posted_transaction_source_trigger on transactions is
  'Protects posted journal source integrity while leaving unposted transaction sync, categorization, review, and duplicate workflows unchanged.';
