import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { canGenerateSandboxUpdate } from '@/lib/plaid-sandbox-refresh';
import {
  createPlaidClientReference,
  createPlaidConnectionReference,
} from '@/lib/plaid-connection-ref';

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export const dynamic = 'force-dynamic';

interface PlaidConnectionAccount {
  name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
}

interface PlaidItemConnectionRow {
  id: string;
  institution_name: string | null;
  status: string;
  financial_source_status: string;
  superseded_by_plaid_item_id: string | null;
  created_at: string;
  last_synced_at: string | null;
  accounts: PlaidConnectionAccount[] | null;
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
        financial_source_status,
        superseded_by_plaid_item_id,
        created_at,
        last_synced_at,
        accounts(name, mask, type, subtype)
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
    const clientRef = createPlaidClientReference(authorizedClient.id);
    const connections = rows.map((item, index) => {
      const institutionName =
        typeof item.institution_name === 'string'
          ? item.institution_name.trim()
          : '';
      const accounts = Array.isArray(item.accounts)
        ? item.accounts
            .map((account) => ({
              name: typeof account.name === 'string' ? account.name : null,
              mask: typeof account.mask === 'string' ? account.mask : null,
              type: typeof account.type === 'string' ? account.type : null,
              subtype: typeof account.subtype === 'string' ? account.subtype : null,
            }))
            .sort((a, b) => `${a.name || ''}:${a.mask || ''}`.localeCompare(`${b.name || ''}:${b.mask || ''}`))
        : [];
      const accountCount = accounts.length;

      return {
        connectionRef: createPlaidConnectionReference(
          authorizedClient.id,
          item.id,
        ),
        label: institutionName || `Bank connection ${index + 1}`,
        status: item.status,
        financialSourceStatus: item.financial_source_status,
        canGenerateSandboxUpdate: canGenerateSandboxUpdate(authorizedClient.id, item.id, item.status, item.financial_source_status),
        supersededByConnectionRef: item.superseded_by_plaid_item_id
          ? createPlaidConnectionReference(authorizedClient.id, item.superseded_by_plaid_item_id)
          : null,
        accountCount,
        accounts,
        connectedAt: item.created_at,
        lastSyncedAt: item.last_synced_at,
      };
    });

    return NextResponse.json({ clientRef, connections });
  } catch {
    return NextResponse.json(
      { error: 'Unable to load connected banks.' },
      { status: 500 },
    );
  }
}
