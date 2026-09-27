import { NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import {
  createPlaidClientReference,
  createPlaidConnectionReference,
  matchesPlaidReference,
} from '@/lib/plaid-connection-ref';

export const dynamic = 'force-dynamic';

function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function failedResponse(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

export async function POST(req: Request) {
  try {
    const authClient = await createRouteHandlerClient();
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      return failedResponse(401, 'Not authenticated.');
    }

    const body = await req.json().catch(() => ({}));
    const plaidItemDatabaseId = body?.plaid_item_database_id;
    const clientRef = body?.clientRef;
    const connectionRef = body?.connectionRef;
    const usesOpaqueReferences =
      typeof clientRef === 'string' && typeof connectionRef === 'string';
    const usesLegacyId = typeof plaidItemDatabaseId === 'string';

    if (!usesOpaqueReferences && !usesLegacyId) {
      return failedResponse(400, 'A Plaid connection is required.');
    }

    const db = createServiceRoleClient();
    const { data: memberships, error: membershipError } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      return failedResponse(500, 'Unable to verify firm membership.');
    }

    const firmIds = Array.from(
      new Set((memberships || []).map((membership) => membership.firm_id)),
    );

    if (firmIds.length === 0) {
      return failedResponse(403, 'You are not associated with an accounting firm.');
    }

    let item: { id: string; status: string } | null = null;

    if (usesOpaqueReferences) {
      const { data: clients, error: clientsError } = await db
        .from('clients')
        .select('id, status')
        .in('firm_id', firmIds);

      if (clientsError) {
        return failedResponse(500, 'Unable to verify the LedgerAI client.');
      }

      const selectedClient = (clients || []).find((client) =>
        matchesPlaidReference(clientRef, createPlaidClientReference(client.id)),
      );

      if (!selectedClient || selectedClient.status !== 'active') {
        return failedResponse(404, 'The Plaid connection was not found.');
      }

      const { data: items, error: itemsError } = await db
        .from('plaid_items')
        .select('id, status')
        .eq('client_id', selectedClient.id)
        .not('plaid_item_id', 'like', 'item_test_%')
        .in('status', ['active', 'error']);

      if (itemsError) {
        return failedResponse(500, 'Unable to verify the Plaid connection.');
      }

      item =
        (items || []).find((candidate) =>
          matchesPlaidReference(
            connectionRef,
            createPlaidConnectionReference(selectedClient.id, candidate.id),
          ),
        ) || null;
    } else {
      const { data: legacyItem, error: itemError } = await db
        .from('plaid_items')
        .select('id, status, clients!inner(firm_id)')
        .eq('id', plaidItemDatabaseId)
        .in('clients.firm_id', firmIds)
        .maybeSingle();

      if (itemError) {
        return failedResponse(500, 'Unable to verify the Plaid Item.');
      }

      item = legacyItem ? { id: legacyItem.id, status: legacyItem.status } : null;
    }

    if (!item) {
      return failedResponse(404, 'The Plaid connection was not found.');
    }

    if (item.status === 'revoked') {
      return failedResponse(400, 'The Plaid Item is revoked and cannot be reconnected.');
    }

    const { data: updatedItem, error: updateError } = await db
      .from('plaid_items')
      .update({ status: 'active' })
      .eq('id', item.id)
      .in('status', ['active', 'error'])
      .select('id')
      .maybeSingle();

    if (updateError || !updatedItem || updatedItem.id !== item.id) {
      return failedResponse(500, 'Unable to complete Plaid reconnection.');
    }

    return NextResponse.json(
      usesOpaqueReferences
        ? { success: true }
        : { success: true, plaid_item_database_id: item.id },
    );
  } catch (error: unknown) {
    console.error(
      '[plaid/reconnect/complete] Failed:',
      error instanceof Error ? error.message : error,
    );
    return failedResponse(500, 'Unable to complete Plaid reconnection.');
  }
}
