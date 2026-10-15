-- LedgerAI - 007_categorization_provenance.sql
-- Preserve how a transaction category was assigned so confidence can be
-- interpreted safely by future review automation.
--
-- Existing rows intentionally remain NULL: historical confidence alone is
-- not enough to reconstruct provenance safely.

alter table public.transactions
  add column if not exists categorization_source text;

alter table public.transactions
  drop constraint if exists transactions_categorization_source_check;

alter table public.transactions
  add constraint transactions_categorization_source_check
  check (
    categorization_source is null
    or categorization_source in ('ai', 'learned_rule', 'local_rule', 'manual')
  );

comment on column public.transactions.categorization_source is
  'How the current category was assigned: ai, learned_rule, local_rule, or manual. NULL means unknown/legacy provenance.';
