import { NextResponse } from 'next/server';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { readPlaidAccessToken } from '@/lib/plaid-token-storage';

export const dynamic = 'force-dynamic';

const plaidEnv =
  (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) ||
  'sandbox';

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: PlaidEnvironments[plaidEnv],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
        'PLAID-SECRET': process.env.PLAID_SECRET!,
      },
    },
  }),
);

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
        {
          success: false,
          error: 'A Plaid Item is required to reconnect a bank.',
        },
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
      .select(`
        id,
        client_id,
        plaid_item_id,
        access_token_encrypted,
        token_key_version,
        clients!inner (firm_id, status)
      `)
      .eq('id', plaidItemDatabaseId)
      .in('clients.firm_id', firmIds)
      .in('status', ['active', 'error'])
      .maybeSingle();

    if (itemError) {
      console.error('[plaid/reconnect-link-token] Item lookup failed:', itemError);
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

    const clientRecord = Array.isArray(item.clients)
      ? item.clients[0]
      : item.clients;

    if (clientRecord?.status !== 'active') {
      return NextResponse.json(
        { success: false, error: 'The selected LedgerAI client is not active.' },
        { status: 400 },
      );
    }

    const accessToken = await readPlaidAccessToken(item);
    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: `ledgerai-client-${item.client_id}`,
      },
      client_name: 'LedgerAI App',
      language: 'en',
      country_codes: ['US'] as any,
      access_token: accessToken,
    } as any);

    return NextResponse.json({
      success: true,
      link_token: response.data.link_token,
      plaid_item_database_id: item.id,
    });
  } catch (error: any) {
    console.error(
      '[plaid/reconnect-link-token] Failed:',
      error?.response?.data || error?.message || error,
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error?.response?.data?.error_message ||
          error?.message ||
          'Unable to initialize Plaid reconnection.',
      },
      { status: 500 },
    );
  }
}
