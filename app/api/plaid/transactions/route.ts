import { NextResponse } from 'next/server';
import { createServerComponentClient } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    const clientId = body?.client_id;

    if (!clientId || typeof clientId !== 'string') {
      return NextResponse.json(
        {
          transactions: [],
          error: 'A valid client_id is required.',
        },
        { status: 400 }
      );
    }

    const supabase = await createServerComponentClient();

    const {
      data: transactions,
      error,
    } = await supabase
      .from('transactions')
      .select(`
        *,
        accounts (
          id,
          name,
          mask,
          type,
          subtype
        )
      `)
      .eq('client_id', clientId)
      .order('posted_date', { ascending: false });

    if (error) {
      console.error(
        'Supabase transactions query error:',
        error.message
      );

      return NextResponse.json(
        {
          transactions: [],
          error: 'Unable to load transactions.',
        },
        { status: 500 }
      );
    }

    const formattedTransactions = (transactions || []).map(
      (transaction: any) => ({
        ...transaction,

        account_name:
          transaction.accounts?.name || null,

        account_mask:
          transaction.accounts?.mask || null,

        account_type:
          transaction.accounts?.type || null,

        account_subtype:
          transaction.accounts?.subtype || null,
      })
    );

    return NextResponse.json(
      {
        transactions: formattedTransactions,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error(
      'Error in transactions route:',
      err
    );

    return NextResponse.json(
      {
        transactions: [],
        error: 'Unable to load transactions.',
      },
      { status: 500 }
    );
  }
}