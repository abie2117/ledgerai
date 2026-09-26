import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createRouteHandlerClient } from '@/lib/supabase-server';

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

interface AccountCountRelation {
  count?: number;
}

interface PlaidItemConnectionRow {
  id: string;
  institution_name: string | null;
  status: string;
  created_at: string;
  last_synced_at: string | null;
  accounts: AccountCountRelation[] | AccountCountRelation | null;
}

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

function getSafeErrorCode(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Za-z0-9_-]{1,40}$/.test(error.code)
  ) {
    return error.code;
  }

  return undefined;
}

export async function GET(request: Request) {
  try {
    const authClient = await createRouteHandlerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Not authenticated.' },
        { status: 401 },
      );
    }

    const clientId = new URL(request.url).searchParams.get('client_id');

    if (!clientId) {
      return NextResponse.json(
        { error: 'client_id is required.' },
        { status: 400 },
      );
    }

    if (!CLIENT_ID_PATTERN.test(clientId)) {
      return NextResponse.json(
        { error: 'client_id is invalid.' },
        { status: 400 },
      );
    }

    const db = createServiceRoleClient();
    const { data: memberships, error: membershipError } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error('[plaid/connections] Membership lookup failed.', {
        code: getSafeErrorCode(membershipError),
      });
      return NextResponse.json(
        { error: 'Unable to verify firm membership.' },
        { status: 500 },
      );
    }

    const firmIds = Array.from(
      new Set((memberships || []).map((membership) => membership.firm_id)),
    );

    if (firmIds.length === 0) {
      return NextResponse.json(
        { error: 'You are not associated with an accounting firm.' },
        { status: 403 },
      );
    }

    const { data: authorizedClient, error: clientError } = await db
      .from('clients')
      .select('id, status')
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (clientError) {
      console.error('[plaid/connections] Client lookup failed.', {
        code: getSafeErrorCode(clientError),
      });
      return NextResponse.json(
        { error: 'Unable to verify the selected client.' },
        { status: 500 },
      );
    }

    if (!authorizedClient) {
      return NextResponse.json(
        { error: 'You do not have access to the selected client.' },
        { status: 403 },
      );
    }

    if (authorizedClient.status !== 'active') {
      return NextResponse.json(
        { error: 'The selected LedgerAI client is not active.' },
        { status: 400 },
      );
    }

    const { data: itemRows, error: itemsError } = await db
      .from('plaid_items')
      .select(`
        id,
        institution_name,
        status,
        created_at,
        last_synced_at,
        accounts(count)
      `)
      .eq('client_id', authorizedClient.id)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });

    if (itemsError) {
      console.error('[plaid/connections] Inventory query failed.', {
        code: getSafeErrorCode(itemsError),
      });
      return NextResponse.json(
        { error: 'Unable to load connected banks.' },
        { status: 500 },
      );
    }

    const rows = (itemRows || []) as PlaidItemConnectionRow[];
    const connections = rows.map((item, index) => {
      const institutionName =
        typeof item.institution_name === 'string'
          ? item.institution_name.trim()
          : '';
      const accountCountRelation = Array.isArray(item.accounts)
        ? item.accounts[0]
        : item.accounts;
      const accountCount =
        typeof accountCountRelation?.count === 'number'
          ? accountCountRelation.count
          : 0;

      return {
        key: `connection-${index + 1}`,
        label: institutionName || `Bank connection ${index + 1}`,
        status: item.status,
        accountCount,
        connectedAt: item.created_at,
        lastSyncedAt: item.last_synced_at,
      };
    });

    return NextResponse.json({ connections });
  } catch {
    return NextResponse.json(
      { error: 'Unable to load connected banks.' },
      { status: 500 },
    );
  }
}
