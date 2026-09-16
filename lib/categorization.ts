import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
      },
    },
  );
}

interface PendingTxn {
  id: string;
  merchant_name: string | null;
  amount: number;
  raw_plaid_category: string | null;
}

interface MappingRule {
  merchant_pattern: string;
  category_id: string;
  confidence_score: number;
}

interface Category {
  id: string;
  name: string;
  coa_code: string | null;
  client_id?: string | null;
  is_default?: boolean | null;
}

function normalizeMerchant(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/*
 * ---------------------------------------------------------
 * CATEGORY LOOKUP
 * ---------------------------------------------------------
 *
 * Client-specific categories take priority.
 * Global/default categories are only used when the client
 * does not already have a category with the same name.
 */

async function getAvailableCategories(
  supabase: ReturnType<typeof supabaseAdmin>,
  clientId: string,
): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select(
      'id, name, coa_code, client_id, is_default',
    )
    .or(
      `client_id.eq.${clientId},client_id.is.null`,
    );

  if (error) {
    throw error;
  }

  const rows = (data || []) as Category[];

  const clientCategories = rows.filter(
    (category) => category.client_id === clientId,
  );

  const globalCategories = rows.filter(
    (category) => category.client_id === null,
  );

  const categoryMap = new Map<string, Category>();

  /*
   * Add global categories first.
   */
  for (const category of globalCategories) {
    categoryMap.set(
      category.name.toLowerCase().trim(),
      category,
    );
  }

  /*
   * Client categories overwrite global categories
   * with the same name.
   */
  for (const category of clientCategories) {
    categoryMap.set(
      category.name.toLowerCase().trim(),
      category,
    );
  }

  return Array.from(categoryMap.values());
}

async function getCategoryById(
  supabase: ReturnType<typeof supabaseAdmin>,
  categoryId: string,
): Promise<Category | null> {
  const { data, error } = await supabase
    .from('categories')
    .select(
      'id, name, coa_code, client_id, is_default',
    )
    .eq('id', categoryId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as Category | null) || null;
}

/*
 * ---------------------------------------------------------
 * APPLY CATEGORY
 * ---------------------------------------------------------
 *
 * IMPORTANT:
 *
 * ai_category_id and the legacy/display category text must
 * stay synchronized.
 */

async function applyCategory(
  supabase: ReturnType<typeof supabaseAdmin>,
  transactionId: string,
  categoryId: string,
  confidence: number,
) {
  const category = await getCategoryById(
    supabase,
    categoryId,
  );

  if (!category) {
    throw new Error(
      `Category ${categoryId} does not exist.`,
    );
  }

  const { error } = await supabase
    .from('transactions')
    .update({
      ai_category_id: category.id,
      ai_confidence: confidence,
      category: category.name,
      updated_at: new Date().toISOString(),
    })
    .eq('id', transactionId);

  if (error) {
    throw error;
  }
}

async function bumpRuleUsage(
  supabase: ReturnType<typeof supabaseAdmin>,
  clientId: string,
  merchantKey: string,
) {
  const { error } = await supabase.rpc(
    'increment_rule_hit_count',
    {
      p_client_id: clientId,
      p_merchant_pattern: merchantKey,
    },
  );

  /*
   * A missing/failed usage counter should not prevent
   * categorization itself from succeeding.
   */
  if (error) {
    console.warn(
      '[categorization] Unable to increment rule usage:',
      error.message,
    );
  }
}

/*
 * ---------------------------------------------------------
 * FULL CATEGORIZATION PIPELINE
 * ---------------------------------------------------------
 *
 * 1. Find pending transactions without ai_category_id.
 * 2. Apply high-confidence learned merchant rules.
 * 3. Send remaining transactions to Claude.
 */

export async function categorizePendingTransactions(
  clientId: string,
) {
  const supabase = supabaseAdmin();

  const { data: pending, error } = await supabase
    .from('transactions')
    .select(
      'id, merchant_name, amount, raw_plaid_category',
    )
    .eq('client_id', clientId)
    .eq('status', 'pending_review')
    .is('ai_category_id', null);

  if (error) {
    throw error;
  }

  if (!pending?.length) {
    return;
  }

  const categories = await getAvailableCategories(
    supabase,
    clientId,
  );

  if (!categories.length) {
    throw new Error(
      'No categories are available for this client.',
    );
  }

  const { data: rules, error: rulesError } =
    await supabase
      .from('category_mapping_rules')
      .select(
        'merchant_pattern, category_id, confidence_score',
      )
      .eq('client_id', clientId);

  if (rulesError) {
    throw rulesError;
  }

  const ruleMap = new Map<string, MappingRule>(
    (rules ?? []).map((rule: any) => [
      normalizeMerchant(rule.merchant_pattern),
      {
        merchant_pattern: rule.merchant_pattern,
        category_id: rule.category_id,
        confidence_score: Number(
          rule.confidence_score || 0,
        ),
      },
    ]),
  );

  const needsClaude: PendingTxn[] = [];

  for (const txn of pending as PendingTxn[]) {
    const key = normalizeMerchant(
      txn.merchant_name ?? '',
    );

    const rule = ruleMap.get(key);

    if (
      rule &&
      Number(rule.confidence_score) >= 0.85
    ) {
      await applyCategory(
        supabase,
        txn.id,
        rule.category_id,
        Number(rule.confidence_score),
      );

      await bumpRuleUsage(
        supabase,
        clientId,
        key,
      );

      continue;
    }

    needsClaude.push(txn);
  }

  if (needsClaude.length) {
    await categorizeBatchWithClaude(
      supabase,
      clientId,
      needsClaude,
      categories,
    );
  }
}

/*
 * ---------------------------------------------------------
 * CLAUDE CATEGORIZATION
 * ---------------------------------------------------------
 *
 * Existing AI functionality is preserved.
 *
 * Claude is only allowed to choose IDs from the supplied
 * category list.
 */

async function categorizeBatchWithClaude(
  supabase: ReturnType<typeof supabaseAdmin>,
  clientId: string,
  txns: PendingTxn[],
  categories: Category[],
) {
  const categoryList = categories
    .map(
      (category) =>
        `- ${category.id}: ${category.name}${
          category.coa_code
            ? ` (${category.coa_code})`
            : ''
        }`,
    )
    .join('\n');

  const txnList = txns
    .map(
      (transaction, index) =>
        `${index}. merchant="${
          transaction.merchant_name ?? 'unknown'
        }", amount=${
          transaction.amount
        }, plaid_category="${
          transaction.raw_plaid_category ?? 'none'
        }"`,
    )
    .join('\n');

  const response =
    await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system:
        'You are a bookkeeping categorization engine. ' +
        'Choose a category_id only when an appropriate category exists in the supplied list. ' +
        'If no supplied category is appropriate or confidence is low, return category_id as null. ' +
        'Never invent a category_id. ' +
        'Respond ONLY with a JSON array, no prose, no markdown fences.',
      messages: [
        {
          role: 'user',
          content:
            `Chart of accounts:\n${categoryList}` +
            `\n\nTransactions to categorize:\n${txnList}` +
            '\n\nRespond with a JSON array like: ' +
            '[{"index":0,"category_id":"...","confidence":0.0}]',
        },
      ],
    });

  const textBlock = response.content.find(
    (block: any) => block.type === 'text',
  );

  if (
    !textBlock ||
    textBlock.type !== 'text'
  ) {
    throw new Error(
      'No text response from Claude.',
    );
  }

  const results: any[] = JSON.parse(
    textBlock.text,
  );

  const validCategoryIds = new Set(
    categories.map((category) => category.id),
  );

  for (const result of results) {
    const txn = txns[result.index];

    if (!txn) {
      continue;
    }

    const categoryId = String(
      result.category_id || '',
    );

    /*
     * Never accept an invented category ID.
     */
    if (!validCategoryIds.has(categoryId)) {
      console.warn(
        '[categorization] Claude returned invalid category:',
        categoryId,
      );

      continue;
    }

    const confidence = Math.max(
      0,
      Math.min(
        1,
        Number(result.confidence || 0),
      ),
    );

    if (!categoryId || confidence < 0.75) {
      continue;
    }

    await applyCategory(
      supabase,
      txn.id,
      categoryId,
      confidence,
    );

    /*
     * Save the merchant mapping for future transactions.
     */
    if (txn.merchant_name) {
      const { error } = await supabase
        .from('category_mapping_rules')
        .upsert(
          {
            client_id: clientId,
            merchant_pattern:
              normalizeMerchant(
                txn.merchant_name,
              ),
            category_id: categoryId,
            confidence_score: confidence,
            last_used_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              'client_id,merchant_pattern',
          },
        );

      if (error) {
        console.warn(
          '[categorization] Unable to save AI rule:',
          error.message,
        );
      }
    }
  }
}

/*
 * ---------------------------------------------------------
 * RECORD MANUAL CORRECTION
 * ---------------------------------------------------------
 */

export async function recordCorrection(
  transactionId: string,
  clientId: string,
  fromCategoryId: string | null,
  toCategoryId: string,
  correctedBy: string,
) {
  const supabase = supabaseAdmin();

  const category = await getCategoryById(
    supabase,
    toCategoryId,
  );

  if (!category) {
    throw new Error(
      `Category ${toCategoryId} does not exist.`,
    );
  }

  const { error: correctionError } =
    await supabase
      .from('category_corrections')
      .insert({
        transaction_id: transactionId,
        client_id: clientId,
        from_category_id: fromCategoryId,
        to_category_id: toCategoryId,
        corrected_by: correctedBy,
      });

  if (correctionError) {
    throw correctionError;
  }

  const { data: txn, error: txnError } =
    await supabase
      .from('transactions')
      .select(
        'merchant_name, client_id',
      )
      .eq('id', transactionId)
      .eq('client_id', clientId)
      .single();

  if (txnError) {
    throw txnError;
  }

  if (txn?.merchant_name) {
    const key = normalizeMerchant(
      txn.merchant_name,
    );

    const { error: ruleError } =
      await supabase
        .from('category_mapping_rules')
        .upsert(
          {
            client_id: clientId,
            merchant_pattern: key,
            category_id: toCategoryId,

            /*
             * A correction begins at 0.60 as in the
             * original learning behavior.
             */
            confidence_score: 0.6,
            last_used_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              'client_id,merchant_pattern',
          },
        );

    if (ruleError) {
      throw ruleError;
    }
  }

  const { error: updateError } =
    await supabase
      .from('transactions')
      .update({
        ai_category_id: toCategoryId,
        ai_confidence: 1,
        category: category.name,
        status: 'confirmed',
        updated_at:
          new Date().toISOString(),
      })
      .eq('id', transactionId)
      .eq('client_id', clientId);

  if (updateError) {
    throw updateError;
  }
}

/*
 * ---------------------------------------------------------
 * SAVE CATEGORY RULE
 * ---------------------------------------------------------
 */

export async function saveCategoryRule(
  clientId: string,
  merchantPattern: string,
  categoryId: string,
  confidenceScore: number = 0.85,
) {
  const supabase = supabaseAdmin();

  /*
   * Validate that the selected category exists.
   */
  const category = await getCategoryById(
    supabase,
    categoryId,
  );

  if (!category) {
    throw new Error(
      `Category ${categoryId} does not exist.`,
    );
  }

  const normalizedConfidence = Math.max(
    0,
    Math.min(
      1,
      Number(confidenceScore || 0),
    ),
  );

  const { data, error } = await supabase
    .from('category_mapping_rules')
    .upsert(
      {
        client_id: clientId,
        merchant_pattern:
          normalizeMerchant(merchantPattern),
        category_id: categoryId,
        confidence_score:
          normalizedConfidence,
        last_used_at:
          new Date().toISOString(),
      },
      {
        onConflict:
          'client_id,merchant_pattern',
      },
    )
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/*
 * ---------------------------------------------------------
 * LOCAL RULE CATEGORIZATION
 * ---------------------------------------------------------
 *
 * This does NOT call Claude.
 *
 * Priority:
 * 1. Existing learned client mapping rule.
 * 2. Conservative local bookkeeping rules.
 * 3. Leave transaction untouched if no safe match exists.
 */

export async function categorizeWithLocalRules(
  clientId: string,
): Promise<{
  categorized: number;
  skipped: number;
}> {
  const supabase = supabaseAdmin();

  const { data: pending, error: pendingError } =
    await supabase
      .from('transactions')
      .select(
        'id, merchant_name, raw_plaid_category',
      )
      .eq('client_id', clientId)
      .eq('status', 'pending_review')
      .is('ai_category_id', null);

  if (pendingError) {
    throw pendingError;
  }

  if (!pending?.length) {
    return {
      categorized: 0,
      skipped: 0,
    };
  }

  const categories =
    await getAvailableCategories(
      supabase,
      clientId,
    );

  if (!categories.length) {
    return {
      categorized: 0,
      skipped: pending.length,
    };
  }

  const { data: mappingRules, error: rulesError } =
    await supabase
      .from('category_mapping_rules')
      .select(
        'merchant_pattern, category_id, confidence_score',
      )
      .eq('client_id', clientId);

  if (rulesError) {
    throw rulesError;
  }

  const learnedRules = new Map<
    string,
    MappingRule
  >(
    (mappingRules || []).map(
      (rule: any) => [
        normalizeMerchant(
          rule.merchant_pattern,
        ),
        {
          merchant_pattern:
            rule.merchant_pattern,
          category_id: rule.category_id,
          confidence_score: Number(
            rule.confidence_score || 0,
          ),
        },
      ],
    ),
  );

  function findCategory(
    hints: string[],
  ): Category | null {
    for (const hint of hints) {
      const normalizedHint =
        hint.toLowerCase();

      const exact = categories.find(
        (category) =>
          category.name
            .toLowerCase()
            .trim() === normalizedHint,
      );

      if (exact) {
        return exact;
      }
    }

    for (const hint of hints) {
      const normalizedHint =
        hint.toLowerCase();

      const partial = categories.find(
        (category) =>
          category.name
            .toLowerCase()
            .includes(normalizedHint),
      );

      if (partial) {
        return partial;
      }
    }

    return null;
  }

  const localRules = [
    {
      pattern:
        /credit card.*payment|card.*payment/i,
      hints: [
        'Credit Card Payments',
        'credit card',
      ],
    },
    {
      pattern:
        /intrst pymnt|interest payment|interest income/i,
      hints: [
        'Interest Income',
        'interest',
      ],
    },
    {
      pattern:
        /aws|amazon web services|cloud hosting/i,
      hints: [
        'Software & Subscriptions',
        'software',
      ],
    },
    {
      pattern:
        /office depot|office supplies|staples/i,
      hints: [
        'Office Supplies',
        'office',
      ],
    },
    {
      pattern:
        /bank transfer|transfer/i,
      hints: [
        'Bank Transfers',
        'transfer',
      ],
    },
    {
      pattern:
        /food and drink|restaurants|fast food|coffee shop|mcdonald|starbucks/i,
      hints: [
        'Food & Dining',
        'Meals',
        'Restaurants',
        'Food',
      ],
    },
    {
      pattern:
        /travel.*taxi|taxi|rideshare|uber|lyft/i,
      hints: [
        'Travel',
        'Transportation',
      ],
    },
    {
      pattern:
        /travel.*airline|airlines|aviation|united airlines/i,
      hints: [
        'Travel',
        'Airfare',
        'Transportation',
      ],
    },
  ];

  let categorized = 0;
  let skipped = 0;
  const needsClaude: PendingTxn[] = [];

  for (const txn of pending) {
    const merchantKey = normalizeMerchant(
      txn.merchant_name ?? '',
    );

    /*
     * -------------------------------------------------------
     * 1. LEARNED CLIENT RULE
     * -------------------------------------------------------
     */

    const learnedRule =
      learnedRules.get(merchantKey);

    if (
      learnedRule &&
      learnedRule.confidence_score >= 0.6
    ) {
      const categoryExists =
        categories.some(
          (category) =>
            category.id ===
            learnedRule.category_id,
        );

      if (categoryExists) {
        await applyCategory(
          supabase,
          txn.id,
          learnedRule.category_id,
          learnedRule.confidence_score,
        );

        await bumpRuleUsage(
          supabase,
          clientId,
          merchantKey,
        );

        categorized++;
        continue;
      }
    }

    /*
     * -------------------------------------------------------
     * 2. CONSERVATIVE LOCAL RULES
     * -------------------------------------------------------
     */

    const searchText =
      `${txn.merchant_name ?? ''} ` +
      `${txn.raw_plaid_category ?? ''}`;

    let matchedCategory: Category | null =
      null;

    for (const rule of localRules) {
      if (!rule.pattern.test(searchText)) {
        continue;
      }

      matchedCategory = findCategory(
        rule.hints,
      );

      if (matchedCategory) {
        break;
      }
    }

    if (!matchedCategory) {
      needsClaude.push(txn as PendingTxn);
      continue;
    }

    await applyCategory(
      supabase,
      txn.id,
      matchedCategory.id,
      1,
    );

    categorized++;
  }

  if (needsClaude.length > 0) {
    try {
      await categorizeBatchWithClaude(
        supabase,
        clientId,
        needsClaude,
        categories,
      );
    } catch (error: any) {
      /*
       * Claude is an optional fallback.
       *
       * If the AI provider is unavailable, out of credits,
       * rate-limited, or returns an unexpected response,
       * keep every category already applied by learned/local
       * rules and leave the remaining transactions safely
       * pending for manual review.
       */
      console.warn(
        '[categorization] AI fallback unavailable. Remaining transactions were left for review:',
        error?.message || error,
      );
    }
  }

  const { count: remainingCount, error: remainingError } =
    await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId)
      .eq('status', 'pending_review')
      .is('ai_category_id', null);

  if (remainingError) {
    throw remainingError;
  }

  skipped = remainingCount || 0;
  categorized = pending.length - skipped;

  return {
    categorized,
    skipped,
  };
}