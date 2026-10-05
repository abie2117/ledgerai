import { SupabaseClient } from '@supabase/supabase-js';

type RecurringTransaction = {
  id: string;
  account_id: string;
  posted_date: string;
  amount: number | string;
  merchant_name: string | null;
  duplicate_of_transaction_id: string | null;
  plaid_removed_at: string | null;
};

type Cadence = 'weekly' | 'monthly' | 'quarterly' | 'annual';

export type RecurringDetectionResult = {
  scanned: number;
  eligible: number;
  candidates: number;
};

type CadenceDefinition = {
  cadence: Cadence;
  minDays: number;
  maxDays: number;
  expectedDays: number;
};

const CADENCES: CadenceDefinition[] = [
  { cadence: 'weekly', minDays: 5, maxDays: 9, expectedDays: 7 },
  { cadence: 'monthly', minDays: 25, maxDays: 35, expectedDays: 30 },
  { cadence: 'quarterly', minDays: 80, maxDays: 100, expectedDays: 91 },
  { cadence: 'annual', minDays: 350, maxDays: 380, expectedDays: 365 },
];

function normalizeMerchant(value: string | null) {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDate(value: string) {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

function daysBetween(left: string, right: string) {
  const leftTime = parseDate(left);
  const rightTime = parseDate(right);

  if (leftTime === null || rightTime === null) {
    return null;
  }

  return Math.round((rightTime - leftTime) / 86_400_000);
}

function addDays(value: string, days: number) {
  const time = parseDate(value);

  if (time === null) {
    return null;
  }

  const date = new Date(time + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]) {
  if (values.length === 0) return 0;

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function detectCadence(dates: string[]) {
  if (dates.length < 3) return null;

  const intervals: number[] = [];

  for (let index = 1; index < dates.length; index += 1) {
    const interval = daysBetween(dates[index - 1], dates[index]);

    if (interval === null || interval <= 0) {
      return null;
    }

    intervals.push(interval);
  }

  for (const definition of CADENCES) {
    const matching = intervals.filter(
      (interval) =>
        interval >= definition.minDays &&
        interval <= definition.maxDays,
    );

    // Require every observed interval to agree with the cadence.
    // This is intentionally conservative for the first detector version.
    if (matching.length === intervals.length) {
      return {
        ...definition,
        intervals,
      };
    }
  }

  return null;
}

/**
 * Detect conservative recurring vendor-spend evidence for one client.
 *
 * Evidence requirements:
 * - active provider transaction (not soft removed)
 * - not a confirmed duplicate
 * - positive Plaid amount (vendor/outflow direction only)
 * - same LedgerAI account
 * - same normalized merchant
 * - at least three occurrences
 * - every observed interval fits one supported cadence window
 *
 * This function never changes transaction/category/journal/reconciliation
 * state. It can only ask the service-role database RPC to upsert an
 * evidence-only recurring_transaction_candidates row.
 */
export async function detectRecurringTransactionCandidates(
  db: SupabaseClient,
  clientId: string,
): Promise<RecurringDetectionResult> {
  const { data, error } = await db
    .from('transactions')
    .select(
      'id, account_id, posted_date, amount, merchant_name, duplicate_of_transaction_id, plaid_removed_at',
    )
    .eq('client_id', clientId)
    .is('plaid_removed_at', null)
    .is('duplicate_of_transaction_id', null)
    .order('posted_date', { ascending: true });

  if (error) {
    throw new Error(
      error.message ||
        'Failed to load transactions for recurring detection.',
    );
  }

  const transactions = (data || []) as RecurringTransaction[];
  const groups = new Map<string, RecurringTransaction[]>();
  let eligible = 0;

  for (const transaction of transactions) {
    const merchant = normalizeMerchant(transaction.merchant_name);
    const amount = Number(transaction.amount);

    if (
      !merchant ||
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !parseDate(transaction.posted_date)
    ) {
      continue;
    }

    eligible += 1;

    const key = `${transaction.account_id}|${merchant}`;
    const group = groups.get(key) || [];
    group.push(transaction);
    groups.set(key, group);
  }

  let candidates = 0;

  for (const group of Array.from(groups.values())) {
    if (group.length < 3) {
      continue;
    }

    group.sort((left, right) =>
      left.posted_date.localeCompare(right.posted_date),
    );

    const merchantPattern = normalizeMerchant(group[0].merchant_name);
    const dates = group.map((transaction) => transaction.posted_date);
    const cadence = detectCadence(dates);

    if (!merchantPattern || !cadence) {
      continue;
    }

    const amounts = group.map((transaction) => Number(transaction.amount));
    const expectedAmount = median(amounts);
    const amountDeviations = amounts.map((amount) =>
      Math.abs(amount - expectedAmount),
    );
    const amountTolerance = Math.max(...amountDeviations, 0);
    const intervalDeviation = Math.max(
      ...cadence.intervals.map((interval) =>
        Math.abs(interval - cadence.expectedDays),
      ),
      0,
    );

    // Confidence is evidence quality, not approval authority.
    // Three observations begin at 0.70, more history adds modest weight,
    // and cadence irregularity reduces the score.
    const historyWeight = Math.min(0.15, (group.length - 3) * 0.03);
    const cadencePenalty = Math.min(0.15, intervalDeviation * 0.01);
    const confidenceScore = Math.max(
      0.5,
      Math.min(0.95, 0.7 + historyWeight - cadencePenalty),
    );

    const nextExpectedDate = addDays(
      group[group.length - 1].posted_date,
      cadence.expectedDays,
    );

    const { error: candidateError } = await db.rpc(
      'upsert_detected_recurring_candidate',
      {
        p_client_id: clientId,
        p_account_id: group[0].account_id,
        p_merchant_pattern: merchantPattern,
        p_cadence: cadence.cadence,
        p_expected_amount: expectedAmount,
        p_amount_tolerance: amountTolerance,
        p_occurrence_count: group.length,
        p_first_occurrence_date: group[0].posted_date,
        p_last_occurrence_date: group[group.length - 1].posted_date,
        p_next_expected_date: nextExpectedDate,
        p_confidence_score: confidenceScore,
        p_evidence: {
          detector_version: 'v1',
          transaction_ids: group.map((transaction) => transaction.id),
          intervals_days: cadence.intervals,
          amount_samples: amounts,
          direction: 'outflow',
          active_provider_transactions_only: true,
          confirmed_duplicates_excluded: true,
        },
      },
    );

    if (candidateError) {
      throw new Error(
        candidateError.message ||
          `Failed to save recurring candidate for ${merchantPattern}.`,
      );
    }

    candidates += 1;
  }

  return {
    scanned: transactions.length,
    eligible,
    candidates,
  };
}
