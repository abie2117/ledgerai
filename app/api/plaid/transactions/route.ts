import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '../../../../lib/supabase-server';

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

    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          transactions: [],
          error: 'Not authenticated.',
        },
        { status: 401 }
      );
    }

    const {
      data: memberships,
      error: membershipError,
    } = await supabase
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      return NextResponse.json(
        {
          transactions: [],
          error: 'Unable to verify client access.',
        },
        { status: 500 }
      );
    }

    const firmIds = (memberships || [])
      .map((membership) => membership.firm_id)
      .filter(Boolean);

    const { data: client, error: clientError } = await supabase
      .from('clients')
      .select('id, firm_id')
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (clientError) {
      return NextResponse.json(
        {
          transactions: [],
          error: 'Unable to verify client access.',
        },
        { status: 500 }
      );
    }

    if (!client) {
      return NextResponse.json(
        {
          transactions: [],
          error: 'Client is not authorized.',
        },
        { status: 403 }
      );
    }

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