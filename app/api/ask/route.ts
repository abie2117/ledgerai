import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServerSupabaseClient } from '@/lib/supabase-server';

function isTotalSpendingThisMonthQuestion(question: string) {
  const normalizedQuestion = question.toLowerCase().trim();

  return (
    normalizedQuestion.includes('total') &&
    normalizedQuestion.includes('spend') &&
    normalizedQuestion.includes('this month')
  );
}

function getCurrentMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
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
      .from('clients')
      .select('id')
      .eq('id', selectedClientId)
      .maybeSingle();

    if (clientError) {
      console.error('[ask] Client authorization query failed:', {
        userId: user.id,
        clientId: selectedClientId,
        message: clientError.message,
        code: clientError.code,
      });

      return NextResponse.json(
        { error: 'Unable to verify the selected client.' },
        { status: 500 },
      );
    }

    if (!client) {
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
      .select('posted_date, amount, merchant_name')
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

    if (isTotalSpendingThisMonthQuestion(question)) {
      const { start, end } = getCurrentMonthRange();
      const total = (transactions || [])
        .filter(
          (transaction) =>
            transaction.posted_date >= start &&
            transaction.posted_date < end &&
            Number(transaction.amount) > 0,
        )
        .reduce(
          (sum, transaction) => sum + Number(transaction.amount || 0),
          0,
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