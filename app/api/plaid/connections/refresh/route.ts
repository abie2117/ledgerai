import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import {
  createPlaidClientReference,
  createPlaidConnectionReference,
  matchesPlaidReference,
} from '@/lib/plaid-connection-ref';
import {
  PlaidItemForSync,
  syncPlaidItem,
} from '@/lib/plaid-sync';

export const dynamic = 'force-dynamic';

const FAILURE_MESSAGE = 'Unable to refresh this connection.';

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

function failedResponse(status: number) {
  return NextResponse.json(
    {
      outcome: 'failed',
      message: FAILURE_MESSAGE,
    },
    { status },
  );
}

export async function POST(request: Request) {
  try {
    const authClient = await createRouteHandlerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return failedResponse(401);
    }

    const body = await request.json().catch(() => ({}));
    const clientRef = body?.clientRef;
    const connectionRef = body?.connectionRef;

    if (
      typeof clientRef !== 'string' ||
      typeof connectionRef !== 'string'
    ) {
      return failedResponse(400);
    }

    const db = createServiceRoleClient();
    const { data: memberships, error: membershipError } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      return failedResponse(500);
    }

    const firmIds = Array.from(
      new Set((memberships || []).map((membership) => membership.firm_id)),
    );

    if (firmIds.length === 0) {
      return failedResponse(403);
    }

    const { data: clients, error: clientsError } = await db
      .from('clients')
      .select('id, status')
      .in('firm_id', firmIds);

    if (clientsError) {
      return failedResponse(500);
    }

    const selectedClient = (clients || []).find((client) =>
      matchesPlaidReference(
        clientRef,
        createPlaidClientReference(client.id),
      ),
    );

    if (!selectedClient) {
      return failedResponse(404);
    }

    if (selectedClient.status !== 'active') {
      return failedResponse(400);
    }

    const { data: plaidItems, error: itemsError } = await db
      .from('plaid_items')
      .select(`
        id,
        client_id,
        plaid_item_id,
        access_token_encrypted,
        token_key_version,
        institution_name,
        status,
        cursor,
        last_synced_at
      `)
      .eq('client_id', selectedClient.id)
      .not('plaid_item_id', 'like', 'item_test_%');

    if (itemsError) {
      return failedResponse(500);
    }

    const item = (plaidItems || []).find(
      (candidate) =>
        candidate.client_id === selectedClient.id &&
        matchesPlaidReference(
          connectionRef,
          createPlaidConnectionReference(selectedClient.id, candidate.id),
        ),
    );

    if (!item) {
      return failedResponse(404);
    }

    if (item.status === 'revoked') {
      return failedResponse(409);
    }

    if (item.status === 'error') {
      return NextResponse.json(
        { outcome: 'reconnect_required' },
        { status: 409 },
      );
    }

    if (item.status !== 'active') {
      return failedResponse(409);
    }

    const result = await syncPlaidItem({
      db,
      item: item as PlaidItemForSync,
    });

    if (result.requires_reauthentication) {
      return NextResponse.json(
        { outcome: 'reconnect_required' },
        { status: 409 },
      );
    }

    if (!result.success) {
      return failedResponse(502);
    }

    return NextResponse.json({
      outcome: 'success',
      added: result.added,
      modified: result.modified,
      removed: result.removed,
      skipped: result.skipped,
    });
  } catch {
    return failedResponse(500);
  }
}