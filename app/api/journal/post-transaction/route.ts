import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

export async function POST(request: Request) {
  try {
    const supabase = await createServerSupabaseClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const transactionId = body?.transactionId;
    const clientId = body?.clientId;

    if (typeof transactionId !== 'string' || typeof clientId !== 'string') {
      return NextResponse.json(
        { error: 'transactionId and clientId are required.' },
        { status: 400 },
      );
    }

    const { data, error } = await supabase.rpc('post_transaction_to_journal', {
      p_transaction_id: transactionId,
      p_client_id: clientId,
    });

    if (error) {
      console.error('[journal/post-transaction] Posting failed:', {
        userId: user.id,
        clientId,
        transactionId,
        code: error.code,
        message: error.message,
      });

      return NextResponse.json(
        { error: error.message || 'Unable to post transaction to journal.' },
        { status: 409 },
      );
    }

    if (typeof data !== 'string' || data.length === 0) {
      return NextResponse.json(
        { error: 'Journal posting did not return an entry.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      transactionId,
      journalEntryId: data,
    });
  } catch (error: unknown) {
    console.error('[journal/post-transaction] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Unable to post transaction to journal.' },
      { status: 500 },
    );
  }
}
