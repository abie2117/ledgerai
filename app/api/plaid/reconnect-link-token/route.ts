import { NextResponse } from 'next/server';
import {
  Configuration,
  CountryCode,
  LinkTokenCreateRequest,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { readPlaidAccessToken } from '@/lib/plaid-token-storage';
import {
  createPlaidClientReference,
  createPlaidConnectionReference,
  matchesPlaidReference,
} from '@/lib/plaid-connection-ref';

export const dynamic = 'force-dynamic';

type ReconnectItem = {
  id: string;
  client_id: string;
  plaid_item_id: string;
  access_token_encrypted: unknown;
  token_key_version: number;
  status?: string | null;
};

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
      auth: { persistSession: false, autoRefreshToken: false },
    },
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

    let item: ReconnectItem | null = null;

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

      if (!selectedClient) {
        return failedResponse(404, 'The Plaid connection was not found.');
      }

      if (selectedClient.status !== 'active') {
        return failedResponse(400, 'The selected LedgerAI client is not active.');
      }

      const { data: items, error: itemsError } = await db
        .from('plaid_items')
        .select('id, client_id, plaid_item_id, access_token_encrypted, token_key_version, status')
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
        .select(`
          id,
          client_id,
          plaid_item_id,
          access_token_encrypted,
          token_key_version,
          status,
          clients!inner (firm_id, status)
        `)
        .eq('id', plaidItemDatabaseId)
        .in('clients.firm_id', firmIds)
        .in('status', ['active', 'error'])
        .maybeSingle();

      if (itemError) {
        return failedResponse(500, 'Unable to verify the Plaid Item.');
      }

      const clientRecord = Array.isArray(legacyItem?.clients)
        ? legacyItem.clients[0]
        : legacyItem?.clients;

      if (legacyItem && clientRecord?.status !== 'active') {
        return failedResponse(400, 'The selected LedgerAI client is not active.');
      }

      item = legacyItem
        ? {
            id: legacyItem.id,
            client_id: legacyItem.client_id,
            plaid_item_id: legacyItem.plaid_item_id,
            access_token_encrypted: legacyItem.access_token_encrypted,
            token_key_version: legacyItem.token_key_version,
            status: legacyItem.status,
          }
        : null;
    }

    if (!item) {
      return failedResponse(404, 'The Plaid connection was not found.');
    }

    const accessToken = await readPlaidAccessToken(item);
    const request: LinkTokenCreateRequest = {
      user: { client_user_id: `ledgerai-client-${item.client_id}` },
      client_name: 'LedgerAI App',
      language: 'en',
      country_codes: [CountryCode.Us],
      access_token: accessToken,
    };
    const response = await plaidClient.linkTokenCreate(request);

    return NextResponse.json(
      usesOpaqueReferences
        ? { success: true, link_token: response.data.link_token }
        : {
            success: true,
            link_token: response.data.link_token,
            plaid_item_database_id: item.id,
          },
    );
  } catch (error: unknown) {
    console.error(
      '[plaid/reconnect-link-token] Failed:',
      error instanceof Error ? error.message : error,
    );
    return failedResponse(500, 'Unable to initialize Plaid reconnection.');
  }
}
