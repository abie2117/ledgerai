export type CategorizationSource =
  | 'ai'
  | 'learned_rule'
  | 'local_rule'
  | 'manual'
  | null
  | undefined;

export interface ReviewPolicyTransaction {
  ai_category_id?: string | null;
  ai_confidence?: number | null;
  categorization_source?: CategorizationSource;
  category?: string | null;
  canonical_category?: {
    name?: string | null;
  } | null;
}

export type ReviewDecision =
  | {
      state: 'needs_attention';
      reason:
        | 'missing_category'
        | 'unknown_provenance'
        | 'low_confidence'
        | 'sensitive_category';
    }
  | {
      state: 'routine';
      reason:
        | 'manual'
        | 'supported_automation';
    };

const SENSITIVE_CATEGORY_PATTERN =
  /\b(transfer|payment|credit card payment|loan payment)\b/i;

function categoryName(
  transaction: ReviewPolicyTransaction,
) {
  return (
    transaction.canonical_category?.name ||
    transaction.category ||
    ''
  ).trim();
}

/**
 * Classify categorization evidence without mutating bookkeeping state.
 *
 * This deliberately does not auto-confirm transactions. It is the
 * safety boundary used to build an exception queue before any future
 * status automation is considered.
 */
export function getReviewDecision(
  transaction: ReviewPolicyTransaction,
): ReviewDecision {
  if (!transaction.ai_category_id) {
    return {
      state: 'needs_attention',
      reason: 'missing_category',
    };
  }

  const source =
    transaction.categorization_source;

  if (!source) {
    return {
      state: 'needs_attention',
      reason: 'unknown_provenance',
    };
  }

  if (source === 'manual') {
    return {
      state: 'routine',
      reason: 'manual',
    };
  }

  if (
    SENSITIVE_CATEGORY_PATTERN.test(
      categoryName(transaction),
    )
  ) {
    return {
      state: 'needs_attention',
      reason: 'sensitive_category',
    };
  }

  const confidence =
    transaction.ai_confidence == null
      ? null
      : Number(transaction.ai_confidence);

  if (
    confidence == null ||
    !Number.isFinite(confidence) ||
    confidence < 0.8
  ) {
    return {
      state: 'needs_attention',
      reason: 'low_confidence',
    };
  }

  return {
    state: 'routine',
    reason: 'supported_automation',
  };
}
