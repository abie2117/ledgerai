import { NextResponse } from 'next/server';
import { createServerComponentClient } from '@/lib/supabase-server';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));

    // If initial load doesn't pass access_token or client_id, return 200 gracefully
    if (!body || (!body.access_token && !body.client_id)) {
      return NextResponse.json(
        { transactions: [], message: 'No active session or client_id provided.' },
        { status: 200 }
      );
    }

    const supabase = createServerComponentClient();
    let query = supabase.from('transactions').select('*');

    if (body.client_id) {
      query = query.eq('client_id', body.client_id);
    }

    const { data: transactions, error } = await query;

    if (error) {
      console.error('Error querying transactions:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ transactions: transactions || [] }, { status: 200 });
  } catch (error: any) {
    console.error('Plaid transactions handler error:', error.message || error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}