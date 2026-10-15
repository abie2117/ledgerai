-- ============================================================
-- DUPLICATE RESOLUTION STATE
--
-- Preserve both bank-feed transactions while allowing one confirmed
-- duplicate copy to be explicitly linked to the retained transaction.
-- Suspected duplicates remain financially active until this field is set.
-- ============================================================

alter table transactions
  add column duplicate_of_transaction_id uuid
    references transactions(id),
  add column duplicate_resolved_at timestamptz,
  add column duplicate_resolved_by uuid
    references auth.users(id);

alter table transactions
  add constraint transactions_duplicate_not_self
    check (
      duplicate_of_transaction_id is null
      or duplicate_of_transaction_id <> id
    );

alter table transactions
  add constraint transactions_duplicate_resolution_metadata
    check (
      (
        duplicate_of_transaction_id is null
        and duplicate_resolved_at is null
        and duplicate_resolved_by is null
      )
      or
      (
        duplicate_of_transaction_id is not null
        and duplicate_resolved_at is not null
        and duplicate_resolved_by is not null
      )
    );

create index transactions_duplicate_of_transaction_id_idx
  on transactions (duplicate_of_transaction_id)
  where duplicate_of_transaction_id is not null;

comment on column transactions.duplicate_of_transaction_id is
  'Confirmed duplicate bookkeeping link. This transaction is the duplicate copy; the referenced transaction is retained as the financial record.';

comment on column transactions.duplicate_resolved_at is
  'Timestamp when a user explicitly confirmed this transaction as a duplicate copy.';

comment on column transactions.duplicate_resolved_by is
  'User who explicitly confirmed this transaction as a duplicate copy.';
