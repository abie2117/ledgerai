import { SupabaseClient } from '@supabase/supabase-js';

type DuplicateDetectionTransaction = {
  id: string;
  account_id: string;
  plaid_transaction_id: string;
  posted_date: string;
  amount: number | string;
  merchant_name: string | null;
};

export type DuplicateDetectionResult = {
  scanned: number;
  candidates: number;
};

function normalizeMerchant(value: string | null) {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateDistanceDays(left: string, right: string) {
  const leftTime = Date.parse(`${left}T00:00:00Z`);
  const rightTime = Date.parse(`${right}T00:00:00Z`);

  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.abs(leftTime - rightTime) / 86_400_000;
}

function canonicalPair(leftId: string, rightId: string) {
  return leftId < rightId
    ? [leftId, rightId]
    : [rightId, leftId];
}

/**
 * Detect narrow, evidence-only duplicate candidates for one client.
 *
 * A match is intentionally conservative:
 * - same LedgerAI account
 * - different Plaid transaction IDs
 * - exact amount
 * - normalized merchant agreement
 * - posting dates no more than one day apart
 *
 * This function never changes transaction financial state. It only inserts
 * idempotent rows into duplicate_candidates for later human review.
 */
export async function detectDuplicateCandidates(
  db: SupabaseClient,
  clientId: string,
): Promise<DuplicateDetectionResult> {
  const { data, error } = await db
    .from('transactions')
    .select(
      'id, account_id, plaid_transaction_id, posted_date, amount, merchant_name',
    )
    .eq('client_id', clientId)
    .order('posted_date', { ascending: true });

  if (error) {
    throw new Error(
      error.message || 'Failed to load transactions for duplicate detection.',
    );
  }

  const transactions = (data || []) as DuplicateDetectionTransaction[];
  const groups = new Map<string, DuplicateDetectionTransaction[]>();

  for (const transaction of transactions) {
    const merchant = normalizeMerchant(transaction.merchant_name);
    const amount = Number(transaction.amount);

    if (!merchant || !Number.isFinite(amount)) {
      continue;
    }

    const key = `${transaction.account_id}|${amount.toFixed(2)}|${merchant}`;
    const group = groups.get(key) || [];
    group.push(transaction);
    groups.set(key, group);
  }

  const candidateRows: Array<{
    client_id: string;
    transaction_a_id: string;
    transaction_b_id: string;
    severity: 'medium';
    evidence: {
      detector_version: 'v1';
      same_account: true;
      exact_amount: true;
      normalized_merchant_match: true;
      date_distance_days: number;
    };
  }> = [];

  for (const group of groups.values()) {
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < group.length;
        rightIndex += 1
      ) {
        const left = group[leftIndex];
        const right = group[rightIndex];

        if (left.plaid_transaction_id === right.plaid_transaction_id) {
          continue;
        }

        const distance = dateDistanceDays(left.posted_date, right.posted_date);

        if (distance > 1) {
          continue;
        }

        const [transactionAId, transactionBId] = canonicalPair(
          left.id,
          right.id,
        );

        candidateRows.push({
          client_id: clientId,
          transaction_a_id: transactionAId,
          transaction_b_id: transactionBId,
          severity: 'medium',
          evidence: {
            detector_version: 'v1',
            same_account: true,
            exact_amount: true,
            normalized_merchant_match: true,
            date_distance_days: distance,
          },
        });
      }
    }
  }

  if (candidateRows.length > 0) {
    const { error: candidateError } = await db
      .from('duplicate_candidates')
      .upsert(candidateRows, {
        onConflict: 'client_id,transaction_a_id,transaction_b_id',
        ignoreDuplicates: true,
      });

    if (candidateError) {
      throw new Error(
        candidateError.message || 'Failed to save duplicate candidates.',
      );
    }
  }

  return {
    scanned: transactions.length,
    candidates: candidateRows.length,
  };
}
