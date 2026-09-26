import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import {
  getCurrentMonthRange,
  getCategorySpendIntent,
  getCategorySpending,
  getFoodDiningSpending,
  getPreviousMonthRange,
  getQualifyingSpendingTransactions,
  getTopMerchantSpending,
  getTransactionsOverAmount,
  sumTransactionAmounts,
  type FinancialTransaction,
} from '@/lib/financial-queries';

function getQuestionIntent(question: string) {
  const normalizedQuestion = question.toLowerCase().trim();

  if (
    normalizedQuestion.includes('food') &&
    normalizedQuestion.includes('dining') &&
    normalizedQuestion.includes('last month')
  ) {
    return 'food-dining-last-month';
  }

  if (
    normalizedQuestion.includes('over $50') ||
    normalizedQuestion.includes('over 50')
  ) {
    return 'transactions-over-50';
  }

  if (
    normalizedQuestion.includes('top 5') &&
    normalizedQuestion.includes('merchant')
  ) {
    return 'top-five-merchants';
  }

  if (
    normalizedQuestion.includes('total') &&
    normalizedQuestion.includes('spend') &&
    normalizedQuestion.includes('this month')
  ) {
    return 'total-spend-this-month';
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const { question, selectedClientId } = await request.json();

    if (!question || !selectedClientId) {
      return NextResponse.json(
        { error: 'Question and client are required.' },
        { status: 400 },
      );
    }

    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      console.error('[ask] Authentication failed:', {
        message: authError?.message || 'No authenticated user.',
      });

      return NextResponse.json(
        { error: 'You must be signed in.' },
        { status: 401 },
      );
    }

    const { data: client, error: clientError } = await supabase
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (clientError) {
      console.error('[ask] Firm authorization query failed:', {
        userId: user.id,
        message: clientError.message,
        code: clientError.code,
      });

      return NextResponse.json(
        { error: 'Unable to verify the selected client.' },
        { status: 500 },
      );
    }

    const firmIds = (client || []).map((membership) => membership.firm_id);

    if (firmIds.length === 0) {
      console.warn('[ask] Client access denied:', {
        userId: user.id,
        clientId: selectedClientId,
      });

      return NextResponse.json(
        { error: 'You do not have access to the selected client.' },
        { status: 403 },
      );
    }

    const { data: authorizedClient, error: authorizedClientError } =
      await supabase
        .from('clients')
        .select('id')
        .eq('id', selectedClientId)
        .in('firm_id', firmIds)
        .maybeSingle();

    if (authorizedClientError) {
      console.error('[ask] Client authorization query failed:', {
        userId: user.id,
        clientId: selectedClientId,
        message: authorizedClientError.message,
        code: authorizedClientError.code,
      });

      return NextResponse.json(
        { error: 'Unable to verify the selected client.' },
        { status: 500 },
      );
    }

    if (!authorizedClient) {
      console.warn('[ask] Client access denied:', {
        userId: user.id,
        clientId: selectedClientId,
      });

      return NextResponse.json(
        { error: 'You do not have access to the selected client.' },
        { status: 403 },
      );
    }

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select(`
        posted_date,
        amount,
        merchant_name,
        raw_plaid_category,
        canonical_category:categories!transactions_ai_category_id_fkey (
          name
        )
      `)
      .eq('client_id', selectedClientId)
      .order('posted_date', { ascending: false });

    if (error) {
      console.error('[ask] Transaction query failed:', {
        userId: user.id,
        clientId: selectedClientId,
        message: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      });

      return NextResponse.json(
        { error: 'Unable to load transactions.' },
        { status: 500 },
      );
    }

    const intent = getQuestionIntent(question);
    const financialTransactions = (transactions || []) as FinancialTransaction[];

    if (intent === 'food-dining-last-month') {
      const total = sumTransactionAmounts(
        getFoodDiningSpending(
          financialTransactions,
          getPreviousMonthRange(),
        ),
      );

      return NextResponse.json({
        answer: `You spent ${new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(total)} on Food & Dining last month.`,
      });
    }

    if (intent === 'transactions-over-50') {
      const matchingTransactions = getTransactionsOverAmount(
        financialTransactions,
        50,
      );

      return NextResponse.json({
        answer: matchingTransactions.length === 0
          ? 'There are no transactions over $50.'
          : matchingTransactions
              .map(
                (transaction) =>
                  `${transaction.posted_date || transaction.date || 'Unknown date'} — ${transaction.merchant_name || transaction.name || 'Unknown merchant'} — ${new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  }).format(Number(transaction.amount || 0))}`,
              )
              .join('\n'),
      });
    }

    if (intent === 'top-five-merchants') {
      const topMerchants = getTopMerchantSpending(financialTransactions);

      return NextResponse.json({
        answer: topMerchants.length === 0
          ? 'There are no qualifying spending transactions.'
          : `Your top 5 merchants by total spend are:\n\n${topMerchants
              .map(
                (merchant, index) =>
                  `${index + 1}. ${merchant.merchant} — ${new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                  }).format(merchant.total)}`,
              )
              .join('\n')}`,
      });
    }

    if (intent === 'total-spend-this-month') {
      const total = sumTransactionAmounts(
        getQualifyingSpendingTransactions(
          financialTransactions,
          getCurrentMonthRange(),
        ),
      );

      return NextResponse.json({
        answer: `You have spent ${new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(total)} in total this month.`,
      });
    }

    const normalizeDiagnosticCategory = (value: string) =>
      value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const diagnosticRows: unknown[] = Array.isArray(transactions)
      ? transactions
      : [];
    const categoryShapeCounts = {
      object: 0,
      array: 0,
      nullOrMissing: 0,
      other: 0,
    };
    const normalizedCanonicalCategoryNames = new Set<string>();
    const normalizedRawCategoryNames = new Set<string>();
    let rowsWithRawCategory = 0;

    for (const row of diagnosticRows) {
      const transaction =
        row !== null && typeof row === 'object'
          ? (row as Record<string, unknown>)
          : {};
      const canonicalCategory = transaction.canonical_category;

      if (Array.isArray(canonicalCategory)) {
        categoryShapeCounts.array += 1;
      } else if (canonicalCategory === null || canonicalCategory === undefined) {
        categoryShapeCounts.nullOrMissing += 1;
      } else if (typeof canonicalCategory === 'object') {
        categoryShapeCounts.object += 1;
        const name = (canonicalCategory as { name?: unknown }).name;

        if (typeof name === 'string') {
          const normalizedName = normalizeDiagnosticCategory(name);
          if (normalizedName) {
            normalizedCanonicalCategoryNames.add(normalizedName);
          }
        }
      } else {
        categoryShapeCounts.other += 1;
      }

      const rawCategory = transaction.raw_plaid_category;

      if (typeof rawCategory === 'string' && rawCategory.trim()) {
        rowsWithRawCategory += 1;
        const normalizedName = normalizeDiagnosticCategory(rawCategory);
        if (normalizedName) {
          normalizedRawCategoryNames.add(normalizedName);
        }
      }
    }

    const normalizedQuestion =
      typeof question === 'string'
        ? normalizeDiagnosticCategory(question)
        : '';
    const questionCategoryMatch = normalizedQuestion.match(
      /\b(?:spend|spent|spending)\b.*?\bon\s+(.+?)\s+(last month|this month)\b/,
    );
    const normalizedQuestionCategoryPhrase =
      questionCategoryMatch?.[1]?.slice(0, 100) || null;
    const categorySpendIntent = getCategorySpendIntent(
      question,
      financialTransactions,
    );

    console.info('[ask/category-diagnostic]', {
      transactionCount: diagnosticRows.length,
      canonicalCategoryShapes: categoryShapeCounts,
      rowsWithNonEmptyRawPlaidCategory: rowsWithRawCategory,
      normalizedCanonicalCategoryNames: Array.from(
        normalizedCanonicalCategoryNames,
      ).sort(),
      normalizedRawPlaidCategoryNames: Array.from(
        normalizedRawCategoryNames,
      ).sort(),
      normalizedQuestionCategoryPhrase,
      deterministicCategoryIntentMatched: Boolean(categorySpendIntent),
    });

    if (categorySpendIntent) {
      const range = categorySpendIntent.period === 'last-month'
        ? getPreviousMonthRange()
        : getCurrentMonthRange();
      const total = sumTransactionAmounts(
        getCategorySpending(
          financialTransactions,
          categorySpendIntent.category,
          range,
        ),
      );
      const periodLabel = categorySpendIntent.period === 'last-month'
        ? 'last month'
        : 'this month';

      return NextResponse.json({
        answer: `You spent ${new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
        }).format(total)} on ${categorySpendIntent.category} ${periodLabel}.`,
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[ask] Anthropic fallback is unavailable.');

      return NextResponse.json(
        {
          error:
            'The finance assistant is temporarily unavailable, so this question could not be answered. Please try again later.',
        },
        { status: 503 },
      );
    }

    const prompt = `
You are a helpful financial dashboard assistant.

Answer the user's question using only the transaction data provided below.

Rules:
- Do not invent information.
- Be clear and concise.
- If the data does not answer the question, say so.
- Positive amounts represent spending.
- Negative amounts represent income or refunds.

User question:
${question}

Transaction data:
${JSON.stringify(transactions || [], null, 2)}
`;

    try {
      const anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
      const response = await anthropic.messages.create({
        model:
          process.env.ANTHROPIC_MODEL ||
          'claude-3-5-sonnet-20240620',
        max_tokens: 800,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const answer = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return NextResponse.json({ answer });
    } catch (error: unknown) {
      const providerStatus =
        error &&
        typeof error === 'object' &&
        'status' in error &&
        typeof error.status === 'number'
          ? error.status
          : undefined;

      console.error('[ask] Anthropic fallback request failed.', {
        status: providerStatus,
      });

      return NextResponse.json(
        {
          error:
            'The finance assistant is temporarily unavailable, so this question could not be answered. Please try again later.',
        },
        { status: 503 },
      );
    }
  } catch (error: unknown) {
    const errorDetails = error instanceof Error ? error : undefined;

    console.error('[ask] Unexpected failure:', {
      message: errorDetails?.message || 'Unknown error',
      name: errorDetails?.name,
    });

    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}