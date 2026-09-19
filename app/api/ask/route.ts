import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createServerSupabaseClient } from '@/lib/supabase-server';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'You must be signed in.' },
        { status: 401 },
      );
    }

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('client_id', selectedClientId)
      .order('date', { ascending: false });

    if (error) {
      console.error('Transaction query error:', error);

      return NextResponse.json(
        { error: 'Unable to load transactions.' },
        { status: 500 },
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
  } catch (error) {
    console.error('Ask API error:', error);

    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 500 },
    );
  }
}