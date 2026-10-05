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
    const clientId = body?.clientId;
    const plaidItemId = body?.plaidItemId;
    const retainedPlaidItemId = body?.retainedPlaidItemId;

    if (
      typeof clientId !== 'string' ||
      typeof plaidItemId !== 'string' ||
      typeof retainedPlaidItemId !== 'string'
    ) {
      return NextResponse.json(
        {
          error:
            'clientId, plaidItemId, and retainedPlaidItemId are required.',
        },
        { status: 400 },
      );
    }

    if (plaidItemId === retainedPlaidItemId) {
      return NextResponse.json(
        { error: 'A Plaid financial source cannot supersede itself.' },
        { status: 400 },
      );
    }

    // The authenticated database RPC is the canonical mutation boundary.
    // It verifies the accounting role, locks both sources, requires the
    // retained source to be financially/provider active, blocks sources
    // with active journals, writes supersession metadata, and audits the
    // acting user atomically.
    const { data, error } = await supabase.rpc(
      'supersede_plaid_financial_source',
      {
        p_client_id: clientId,
        p_plaid_item_id: plaidItemId,
        p_retained_plaid_item_id: retainedPlaidItemId,
      },
    );

    if (error) {
      console.error('[plaid/source-resolution] Supersession failed:', {
        userId: user.id,
        clientId,
        plaidItemId,
        retainedPlaidItemId,
        code: error.code,
        message: error.message,
      });

      return NextResponse.json(
        {
          error:
            error.message || 'Unable to supersede Plaid financial source.',
        },
        { status: 409 },
      );
    }

    if (typeof data !== 'string' || data.length === 0) {
      return NextResponse.json(
        { error: 'Financial source supersession did not return a source.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      plaidItemId: data,
      retainedPlaidItemId,
    });
  } catch (error: unknown) {
    console.error('[plaid/source-resolution] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Unable to supersede Plaid financial source.' },
      { status: 500 },
    );
  }
}
