// app/api/plaid/exchange/route.ts

import { NextResponse } from 'next/server';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import {
  PlaidItemForSync,
  syncPlaidItem,
} from '@/lib/plaid-sync';

export const dynamic = 'force-dynamic';

const plaidEnv =
  (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) ||
  'sandbox';

const configuration = new Configuration({
  basePath: PlaidEnvironments[plaidEnv],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

function getPlaidErrorCode(error: any) {
  return (
    error?.response?.data?.error_code ||
    error?.error_code ||
    null
  );
}

export async function POST(req: Request) {
  try {
    // ---------------------------------------------------------
    // 1. AUTHENTICATE CURRENT USER
    // ---------------------------------------------------------

    const authClient = await createRouteHandlerClient();

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      console.error(
        '[plaid/exchange] Authentication failed:',
        authError
      );

      return NextResponse.json(
        {
          success: false,
          error: 'Not authenticated',
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 2. READ REQUEST BODY
    // ---------------------------------------------------------

    const body = await req.json().catch(() => ({}));

    const publicToken = body?.public_token;

    if (
      !publicToken ||
      typeof publicToken !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing or invalid public_token.',
        },
        { status: 400 }
      );
    }

    const clientId =
      body?.client_id ||
      body?.clientId ||
      null;

    /*
     * IMPORTANT:
     *
     * Never guess which LedgerAI client owns a bank connection.
     * The frontend must explicitly provide the selected clients.id.
     */

    if (
      !clientId ||
      typeof clientId !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            'A LedgerAI client must be selected before connecting a bank.',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 3. CREATE SERVICE-ROLE DATABASE CLIENT
    // ---------------------------------------------------------

    const db = createServiceRoleClient();

    // ---------------------------------------------------------
    // 4. FIND THE USER'S FIRMS
    // ---------------------------------------------------------

    const {
      data: memberships,
      error: membershipError,
    } = await db
      .from('firm_users')
      .select('firm_id, role')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error(
        '[plaid/exchange] Failed to load firm memberships:',
        membershipError
      );

      return NextResponse.json(
        {
          success: false,
          error: 'Unable to verify firm membership.',
        },
        { status: 500 }
      );
    }

    if (!memberships || memberships.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'You are not associated with an accounting firm.',
        },
        { status: 403 }
      );
    }

    const firmIds = memberships.map(
      (membership) => membership.firm_id
    );

    // ---------------------------------------------------------
    // 5. VERIFY THE SELECTED LEDGERAI CLIENT
    // ---------------------------------------------------------

    const {
      data: selectedClient,
      error: selectedClientError,
    } = await db
      .from('clients')
      .select(
        'id, firm_id, business_name, status'
      )
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (selectedClientError) {
      console.error(
        '[plaid/exchange] Selected client lookup failed:',
        selectedClientError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Failed to verify the selected LedgerAI client.',
        },
        { status: 500 }
      );
    }

    if (!selectedClient) {
      return NextResponse.json(
        {
          success: false,
          error:
            'The selected client does not belong to one of your firms.',
        },
        { status: 403 }
      );
    }

    if (selectedClient.status !== 'active') {
      return NextResponse.json(
        {
          success: false,
          error:
            'The selected LedgerAI client is not active.',
        },
        { status: 400 }
      );
    }

    console.log(
      '[plaid/exchange] Selected client:',
      selectedClient.id,
      selectedClient.business_name
    );

    // ---------------------------------------------------------
    // 6. EXCHANGE PLAID PUBLIC TOKEN
    // ---------------------------------------------------------

    const exchangeResponse =
      await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });

    const accessToken =
      exchangeResponse.data.access_token;

    const plaidItemId =
      exchangeResponse.data.item_id;

    // ---------------------------------------------------------
    // 7. GET PLAID ACCOUNTS
    // ---------------------------------------------------------

    const accountsResponse =
      await plaidClient.accountsGet({
        access_token: accessToken,
      });

    const plaidAccounts =
      accountsResponse.data.accounts || [];

    if (plaidAccounts.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Plaid connected, but no bank accounts were returned.',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 8. SAVE PLAID ITEM
    // ---------------------------------------------------------

    const {
      data: plaidItem,
      error: plaidItemError,
    } = await authClient.rpc(
      'insert_plaid_item_encrypted',
      {
        p_client_id: clientId,
        p_plaid_item_id: plaidItemId,
        p_access_token: accessToken,
        p_institution_name: null,
      }
    );

    if (
      plaidItemError ||
      typeof plaidItem !== 'string' ||
      !plaidItem
    ) {
      console.error(
        '[plaid/exchange] Failed to save Plaid item:',
        plaidItemError?.message ||
          'RPC returned no local Plaid item ID.'
      );

      return NextResponse.json(
        {
          success: false,
          error: 'Failed to save Plaid connection.',
        },
        { status: 500 }
      );
    }

    const plaidItemDatabaseId = plaidItem;

    // ---------------------------------------------------------
    // 9. SAVE PLAID ACCOUNTS
    // ---------------------------------------------------------

    const accountIdMap =
      new Map<string, string>();

    for (const account of plaidAccounts) {
      const {
        data: accountRow,
        error: accountError,
      } = await db
        .from('accounts')
        .upsert(
          {
            plaid_item_id:
              plaidItemDatabaseId,

            plaid_account_id:
              account.account_id,

            name:
              account.name ||
              'Plaid Account',

            mask:
              account.mask || null,

            type:
              account.type || null,

            subtype:
              account.subtype || null,
          },
          {
            onConflict: 'plaid_account_id',
          }
        )
        .select(
          'id, plaid_account_id'
        )
        .single();

      if (accountError || !accountRow) {
        console.error(
          '[plaid/exchange] Failed to save account:',
          {
            plaidAccountId:
              account.account_id,
            error: accountError,
          }
        );

        continue;
      }

      accountIdMap.set(
        account.account_id,
        accountRow.id
      );
    }

    if (accountIdMap.size === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Plaid connected, but no LedgerAI bank accounts could be saved.',
        },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------
    // 10. INITIALIZE TRANSACTIONS THROUGH THE SHARED SYNC ENGINE
    // ---------------------------------------------------------

    /*
     * Initial connection, manual refresh, and Plaid webhooks must
     * use one transaction mutation engine. The new Plaid Item has
     * a null cursor, so syncPlaidItem starts from the beginning and
     * persists its final cursor only after transaction mutations
     * succeed.
     *
     * Reading the access token back through the encrypted token
     * storage path also verifies that the persisted connection is
     * usable before transaction ingestion begins.
     */

    const {
      data: storedPlaidItem,
      error: storedPlaidItemError,
    } = await db
      .from('plaid_items')
      .select(
        'id, client_id, plaid_item_id, access_token_encrypted, token_key_version, institution_name, status, cursor, last_synced_at'
      )
      .eq('id', plaidItemDatabaseId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (storedPlaidItemError || !storedPlaidItem) {
      console.error(
        '[plaid/exchange] Failed to reload persisted Plaid item:',
        storedPlaidItemError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Bank connection was saved, but LedgerAI could not initialize synchronization.',
        },
        { status: 500 }
      );
    }

    const syncResult = await syncPlaidItem({
      db,
      item: storedPlaidItem as PlaidItemForSync,
    });

    if (!syncResult.success) {
      console.warn(
        '[plaid/exchange] Bank connected but initial transaction sync is not ready:',
        {
          clientId,
          plaidItemId,
          errorCode:
            syncResult.error_code || null,
          error:
            syncResult.error || null,
        }
      );

      return NextResponse.json({
        success: true,
        plaid_item_id:
          plaidItemDatabaseId,
        client_id: clientId,
        accounts:
          accountIdMap.size,
        plaid_transactions: 0,
        count: 0,
        cursor_initialized: false,
        message:
          'Bank connected successfully. Transaction synchronization will be initialized when transaction data is available.',
      });
    }

    const {
      data: synchronizedPlaidItem,
      error: synchronizedPlaidItemError,
    } = await db
      .from('plaid_items')
      .select('cursor')
      .eq('id', plaidItemDatabaseId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (synchronizedPlaidItemError) {
      console.warn(
        '[plaid/exchange] Initial sync completed but cursor verification failed:',
        synchronizedPlaidItemError
      );
    }

    const cursorInitialized =
      Boolean(
        synchronizedPlaidItem?.cursor
      );

    console.log(
      '[plaid/exchange] SUCCESS',
      {
        authenticatedUser:
          user.id,
        clientId,
        plaidItemId,
        localPlaidItemId:
          plaidItemDatabaseId,
        accounts:
          accountIdMap.size,
        added:
          syncResult.added,
        modified:
          syncResult.modified,
        removed:
          syncResult.removed,
        skipped:
          syncResult.skipped,
        cursorInitialized,
      }
    );

    return NextResponse.json({
      success: true,
      plaid_item_id:
        plaidItemDatabaseId,
      client_id:
        clientId,
      accounts:
        accountIdMap.size,
      plaid_transactions:
        syncResult.added,
      added:
        syncResult.added,
      modified:
        syncResult.modified,
      removed:
        syncResult.removed,
      count:
        syncResult.added,
      cursor_initialized:
        cursorInitialized,
      message:
        cursorInitialized
          ? 'Bank connected and transactions synchronized successfully.'
          : 'Bank connected successfully. Transaction history is still being prepared by Plaid.',
    });
  } catch (error: any) {
    console.error(
      '[plaid/exchange] FAILED:',
      error?.response?.data ||
        error?.message ||
        error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          error?.response?.data?.error_message ||
          error?.message ||
          'Failed to connect bank account.',
      },
      { status: 500 }
    );
  }
}