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
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => ({}));

    const exceptionId =
      typeof body?.exceptionId === 'string'
        ? body.exceptionId.trim()
        : '';

    const clientId =
      typeof body?.clientId === 'string'
        ? body.clientId.trim()
        : '';

    const action =
      body?.action === 'accept' || body?.action === 'dismiss'
        ? body.action
        : '';

    const resolutionNote =
      typeof body?.resolutionNote === 'string'
        ? body.resolutionNote.trim()
        : '';

    if (!exceptionId || !clientId || !action) {
      return NextResponse.json(
        {
          error:
            'exceptionId, clientId, and a valid action are required.',
        },
        { status: 400 },
      );
    }

    const { data, error } = await supabase.rpc(
      'resolve_provider_transaction_exception',
      {
        p_exception_id: exceptionId,
        p_client_id: clientId,
        p_action: action,
        p_resolution_note: resolutionNote || null,
      },
    );

    if (error) {
      console.error(
        '[provider-exceptions/resolve] Resolution failed:',
        {
          userId: user.id,
          clientId,
          exceptionId,
          action,
          code: error.code,
          message: error.message,
        },
      );

      return NextResponse.json(
        {
          error:
            error.message ||
            'Unable to resolve provider transaction exception.',
        },
        { status: 409 },
      );
    }

    const resolution = Array.isArray(data) ? data[0] : null;

    if (!resolution) {
      return NextResponse.json(
        {
          error:
            'Provider exception resolution did not return a result.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      exceptionId: resolution.exception_id,
      transactionId: resolution.transaction_id,
      eventType: resolution.event_type,
      status: resolution.resolution_status,
      journalReposted: Boolean(resolution.journal_reposted),
    });
  } catch (error: unknown) {
    console.error(
      '[provider-exceptions/resolve] Unexpected error:',
      error,
    );

    return NextResponse.json(
      {
        error:
          'Unable to resolve provider transaction exception.',
      },
      { status: 500 },
    );
  }
}
