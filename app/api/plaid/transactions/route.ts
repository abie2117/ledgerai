import { NextResponse } from 'next/server';
import { createServerComponentClient } from '../../../../lib/supabase-server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const clientId = body.client_id || body.client_name;
    const supabase = await createServerComponentClient();

    // 1. First attempt: Query transactions matching client identifier
    let transactions: any[] = [];
    if (clientId) {
      const { data } = await supabase
        .from('transactions')
        .select('*')
        .eq('client_id', clientId);
      if (data && data.length > 0) {
        transactions = data;
      }
    }

    // 2. Fallback: If no client match or client_id is missing, load all transactions
    if (transactions.length === 0) {
      const { data: allTransactions, error } = await supabase
        .from('transactions')
        .select('*');

      if (error) {
        console.error('Supabase Query Error:', error.message);
        return NextResponse.json({ transactions: [] }, { status: 200 });
      }
      transactions = allTransactions || [];
    }

    return NextResponse.json({ transactions }, { status: 200 });
  } catch (err: any) {
    console.error('Error in transactions route:', err);
    return NextResponse.json({ transactions: [] }, { status: 200 });
  }
}