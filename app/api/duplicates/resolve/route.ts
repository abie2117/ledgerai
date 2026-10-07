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
    const candidateId = body?.candidateId;
    const clientId = body?.clientId;
    const duplicateTransactionId = body?.duplicateTransactionId;

    if (
      typeof candidateId !== 'string' ||
      typeof clientId !== 'string' ||
      typeof duplicateTransactionId !== 'string'
    ) {
      return NextResponse.json(
        { error: 'candidateId, clientId, and duplicateTransactionId are required.' },
        { status: 400 },
      );
    }

    const { data, error } = await supabase.rpc('resolve_duplicate_candidate', {
      p_candidate_id: candidateId,
      p_client_id: clientId,
      p_duplicate_transaction_id: duplicateTransactionId,
    });

    if (error) {
      console.error('[duplicates/resolve] Resolution failed:', {
        userId: user.id,
        clientId,
        candidateId,
        code: error.code,
        message: error.message,
      });

      return NextResponse.json(
        { error: error.message || 'Unable to resolve duplicate candidate.' },
        { status: 409 },
      );
    }

    const resolution = Array.isArray(data) ? data[0] : null;

    if (!resolution) {
      return NextResponse.json(
        { error: 'Duplicate resolution did not return a result.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      candidateId: resolution.candidate_id,
      duplicateTransactionId: resolution.duplicate_transaction_id,
      retainedTransactionId: resolution.retained_transaction_id,
    });
  } catch (error: unknown) {
    console.error('[duplicates/resolve] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Unable to resolve duplicate candidate.' },
      { status: 500 },
    );
  }
}
