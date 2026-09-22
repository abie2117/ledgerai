import { NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

export async function POST(req: Request) {
  try {
    const authClient = await createRouteHandlerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated.' },
        { status: 401 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const plaidItemDatabaseId = body?.plaid_item_database_id;

    if (
      !plaidItemDatabaseId ||
      typeof plaidItemDatabaseId !== 'string'
    ) {
      return NextResponse.json(
        { success: false, error: 'A Plaid Item is required.' },
        { status: 400 },
      );
    }

    const db = createServiceRoleClient();
    const { data: memberships, error: membershipError } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      return NextResponse.json(
        { success: false, error: 'Unable to verify firm membership.' },
        { status: 500 },
      );
    }

    const firmIds = (memberships || []).map((membership) => membership.firm_id);

    if (firmIds.length === 0) {
      return NextResponse.json(
        { success: false, error: 'You are not associated with an accounting firm.' },
        { status: 403 },
      );
    }

    const { data: item, error: itemError } = await db
      .from('plaid_items')
      .select('id, clients!inner(firm_id)')
      .eq('id', plaidItemDatabaseId)
      .in('clients.firm_id', firmIds)
      .maybeSingle();

    if (itemError) {
      return NextResponse.json(
        { success: false, error: 'Unable to verify the Plaid Item.' },
        { status: 500 },
      );
    }

    if (!item) {
      return NextResponse.json(
        { success: false, error: 'The Plaid Item was not found.' },
        { status: 404 },
      );
    }

    const { error: updateError } = await db
      .from('plaid_items')
      .update({ status: 'active' })
      .eq('id', item.id);

    if (updateError) {
      return NextResponse.json(
        { success: false, error: 'Unable to reactivate the Plaid Item.' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true,
      plaid_item_database_id: item.id,
    });
  } catch (error: any) {
    console.error(
      '[plaid/reconnect/complete] Failed:',
      error?.message || error,
    );

    return NextResponse.json(
      { success: false, error: 'Unable to complete Plaid reconnection.' },
      { status: 500 },
    );
  }
}
