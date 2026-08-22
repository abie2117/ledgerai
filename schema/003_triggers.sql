-- LedgerAI — 003_triggers.sql
-- Automates the "compounding accuracy" mechanism at the database level,
-- so it holds true regardless of which app code path writes the data:
--   - A bookkeeper CONFIRMING an AI category (no change) should nudge that
--     merchant→category rule's confidence UP.
--   - A bookkeeper CORRECTING an AI category should nudge the OLD rule's
--     confidence DOWN and strengthen/create the rule for the NEW category.

-- ============================================================
-- Helper used by both triggers and by lib/categorization.ts directly.
-- ============================================================
create or replace function increment_rule_hit_count(
  p_client_id uuid,
  p_merchant_pattern text
) returns void
language sql
security definer
set search_path = public
as $$
  update category_mapping_rules
  set hit_count = hit_count + 1,
      last_used_at = now(),
      confidence_score = least(0.99, confidence_score + 0.03)
  where client_id = p_client_id and merchant_pattern = p_merchant_pattern;
$$;

revoke all on function increment_rule_hit_count from public;
grant execute on function increment_rule_hit_count to authenticated, service_role;

-- ============================================================
-- Trigger 1: transaction confirmed as-is (no correction row exists for it)
-- → treat as a positive signal for the existing mapping rule.
-- ============================================================
create or replace function handle_transaction_confirmation() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant text;
  v_corrected boolean;
begin
  -- Only act on the transition INTO 'confirmed'
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then

    -- Was this confirmation actually a correction? If a category_corrections
    -- row already exists for this transaction, trigger 2 handles it instead —
    -- avoid double-counting.
    select exists (
      select 1 from category_corrections where transaction_id = new.id
    ) into v_corrected;

    if not v_corrected and new.merchant_name is not null and new.ai_category_id is not null then
      v_merchant := lower(trim(regexp_replace(new.merchant_name, '\s+', ' ', 'g')));

      insert into category_mapping_rules (client_id, merchant_pattern, category_id, confidence_score, hit_count, last_used_at)
      values (new.client_id, v_merchant, new.ai_category_id, 0.6, 1, now())
      on conflict (client_id, merchant_pattern)
      do update set
        hit_count = category_mapping_rules.hit_count + 1,
        last_used_at = now(),
        confidence_score = least(0.99, category_mapping_rules.confidence_score + 0.03);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_transaction_confirmation on transactions;
create trigger trg_transaction_confirmation
  after update on transactions
  for each row
  execute function handle_transaction_confirmation();

-- ============================================================
-- Trigger 2: a correction was logged → penalize the rule that produced
-- the wrong guess and strengthen the rule pointing at the corrected category.
-- ============================================================
create or replace function handle_category_correction() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_merchant text;
begin
  select lower(trim(regexp_replace(merchant_name, '\s+', ' ', 'g')))
  into v_merchant
  from transactions where id = new.transaction_id;

  if v_merchant is null then
    return new;
  end if;

  -- The rule that led to the wrong category (if any) loses confidence.
  -- It is not deleted — a merchant can legitimately span categories over
  -- time, and a demoted-but-present rule is safer than losing history.
  if new.from_category_id is not null then
    update category_mapping_rules
    set confidence_score = greatest(0.10, confidence_score - 0.25)
    where client_id = new.client_id
      and merchant_pattern = v_merchant
      and category_id = new.from_category_id;
  end if;

  -- The corrected category becomes (or strengthens as) the rule for this
  -- merchant. Confidence resets to a moderate 0.6 rather than jumping to
  -- high confidence immediately — it has to re-earn trust via subsequent
  -- confirmations (trigger 1), same as a brand-new rule would.
  insert into category_mapping_rules (client_id, merchant_pattern, category_id, confidence_score, hit_count, last_used_at)
  values (new.client_id, v_merchant, new.to_category_id, 0.6, 1, now())
  on conflict (client_id, merchant_pattern)
  do update set
    category_id = new.to_category_id,
    confidence_score = 0.6,
    hit_count = category_mapping_rules.hit_count + 1,
    last_used_at = now();

  return new;
end;
$$;

drop trigger if exists trg_category_correction on category_corrections;
create trigger trg_category_correction
  after insert on category_corrections
  for each row
  execute function handle_category_correction();

-- ============================================================
-- Housekeeping: keep transactions.updated_at fresh on any change,
-- so "last touched" is reliable for firm-facing activity views.
-- ============================================================
create or replace function touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_transactions_touch on transactions;
create trigger trg_transactions_touch
  before update on transactions
  for each row
  execute function touch_updated_at();
