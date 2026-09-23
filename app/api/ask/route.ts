import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import {
  getCurrentMonthRange,
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
        date,
        amount,
        merchant_name,
        category,
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

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[ask] ANTHROPIC_API_KEY is not configured.');

      return NextResponse.json(
        { error: 'The finance assistant is not configured.' },
        { status: 503 },
      );
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

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
  } catch (error: any) {
    console.error('[ask] Unexpected failure:', {
      message: error?.message || 'Unknown error',
      name: error?.name,
      status: error?.status,
      code: error?.code,
    });

    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}