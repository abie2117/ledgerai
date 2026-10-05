import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';
import { createPlaidConnectionReference, matchesPlaidReference } from '@/lib/plaid-connection-ref';

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
    const connectionRef = body?.connectionRef;
    const retainedConnectionRef = body?.retainedConnectionRef;

    if (typeof clientId !== 'string') {
      return NextResponse.json({ error: 'clientId is required.' }, { status: 400 });
    }

    let sourceId = typeof plaidItemId === 'string' ? plaidItemId : '';
    let retainedId = typeof retainedPlaidItemId === 'string' ? retainedPlaidItemId : '';

    if (!sourceId || !retainedId) {
      const { data: items, error: itemsError } = await supabase
        .from('plaid_items')
        .select('id')
        .eq('client_id', clientId);

      if (itemsError) {
        return NextResponse.json({ error: 'Unable to verify bank connections.' }, { status: 500 });
      }

      sourceId =
        (items || []).find((item) =>
          matchesPlaidReference(connectionRef, createPlaidConnectionReference(clientId, item.id)),
        )?.id || '';
      retainedId =
        (items || []).find((item) =>
          matchesPlaidReference(retainedConnectionRef, createPlaidConnectionReference(clientId, item.id)),
        )?.id || '';
    }

    if (!sourceId || !retainedId) {
      return NextResponse.json(
        { error: 'Valid source and retained bank connections are required.' },
        { status: 400 },
      );
    }

    if (sourceId === retainedId) {
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
        p_plaid_item_id: sourceId,
        p_retained_plaid_item_id: retainedId,
      },
    );

    if (error) {
      console.error('[plaid/source-resolution] Supersession failed:', {
        userId: user.id,
        clientId,
        plaidItemId: sourceId,
        retainedPlaidItemId: retainedId,
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
      retainedPlaidItemId: retainedId,
    });
  } catch (error: unknown) {
    console.error('[plaid/source-resolution] Unexpected error:', error);
    return NextResponse.json(
      { error: 'Unable to supersede Plaid financial source.' },
      { status: 500 },
    );
  }
}
