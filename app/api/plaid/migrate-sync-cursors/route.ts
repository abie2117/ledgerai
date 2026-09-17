import { NextResponse } from 'next/server';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

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
      return NextResponse.json(
        {
          success: false,
          error: 'Not authenticated.',
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 2. REQUIRE AN EXPLICIT LEDGERAI CLIENT
    // ---------------------------------------------------------

    const body = await req.json().catch(() => ({}));

    const clientId =
      body?.client_id ||
      body?.clientId ||
      null;

    if (!clientId || typeof clientId !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error:
            'A LedgerAI client must be selected before migrating sync cursors.',
        },
        { status: 400 }
      );
    }

    const db = createServiceRoleClient();

    // ---------------------------------------------------------
    // 3. VERIFY FIRM MEMBERSHIP
    // ---------------------------------------------------------

    const {
      data: memberships,
      error: membershipError,
    } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error(
        '[plaid/migrate-sync-cursors] Membership lookup failed:',
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

    const firmIds = Array.from(
      new Set(
        memberships.map(
          (membership) => membership.firm_id
        )
      )
    );

    // ---------------------------------------------------------
    // 4. VERIFY THE SELECTED CLIENT
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
        '[plaid/migrate-sync-cursors] Client lookup failed:',
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

    // ---------------------------------------------------------
    // 5. LOAD ONLY LEGACY PLAID ITEMS
    //
    // Legacy means:
    // - belongs to this client
    // - active
    // - cursor has never been initialized
    // - last_synced_at exists because /transactions/get
    //   previously imported transaction data
    // ---------------------------------------------------------

    const {
      data: plaidItems,
      error: plaidItemsError,
    } = await db
      .from('plaid_items')
      .select(`
        id,
        client_id,
        plaid_item_id,
        access_token_encrypted,
        status,
        cursor,
        last_synced_at
      `)
      .eq('client_id', clientId)
      .eq('status', 'active')
      .is('cursor', null)
      .not('last_synced_at', 'is', null);

    if (plaidItemsError) {
      console.error(
        '[plaid/migrate-sync-cursors] Plaid Item lookup failed:',
        plaidItemsError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Unable to load legacy Plaid Items.',
        },
        { status: 500 }
      );
    }

    const eligibleItems = (plaidItems || []).filter(
      (item) =>
        typeof item.plaid_item_id === 'string' &&
        !item.plaid_item_id.startsWith('item_test_')
    );

    if (eligibleItems.length === 0) {
      return NextResponse.json({
        success: true,
        client_id: clientId,
        client_name: selectedClient.business_name,
        migrated: 0,
        failed: 0,
        results: [],
        message:
          'No legacy Plaid Items require cursor migration.',
      });
    }

    // ---------------------------------------------------------
    // 6. MIGRATE EACH ELIGIBLE ITEM
    // ---------------------------------------------------------

    const results: Array<{
      plaid_item_database_id: string;
      plaid_item_id: string;
      success: boolean;
      cursor_saved: boolean;
      error?: string;
    }> = [];

    for (const item of eligibleItems) {
      try {
        // Existing exchange logic stores the access token as
        // base64 inside the bytea column.
        const storedToken =
          item.access_token_encrypted;

        let encodedToken: string;

        if (typeof storedToken === 'string') {
          encodedToken = storedToken;
        } else if (
          storedToken &&
          typeof storedToken === 'object' &&
          'data' in storedToken &&
          Array.isArray(
            (storedToken as { data?: unknown }).data
          )
        ) {
          encodedToken = Buffer.from(
            (
              storedToken as {
                data: number[];
              }
            ).data
          ).toString('utf8');
        } else {
          throw new Error(
            'Unsupported access-token storage format.'
          );
        }

        // Supabase may return bytea either as the original textual
        // value or in PostgreSQL bytea hex representation.
        if (encodedToken.startsWith('\\x')) {
          encodedToken = Buffer.from(
            encodedToken.slice(2),
            'hex'
          ).toString('utf8');
        }

        const accessToken = Buffer.from(
          encodedToken,
          'base64'
        ).toString('utf8');

        if (!accessToken) {
          throw new Error(
            'Stored Plaid access token could not be decoded.'
          );
        }

        // -----------------------------------------------------
        // IMPORTANT:
        // "now" is ONLY for existing Items that already had
        // transaction history imported via /transactions/get.
        //
        // It intentionally returns no historical updates and
        // establishes a cursor for future /transactions/sync.
        // -----------------------------------------------------

        const syncResponse =
          await plaidClient.transactionsSync({
            access_token: accessToken,
            cursor: 'now',
            count: 500,
          });

        const nextCursor =
          syncResponse.data.next_cursor;

        if (
          !nextCursor ||
          typeof nextCursor !== 'string'
        ) {
          throw new Error(
            'Plaid did not return a migration cursor.'
          );
        }

        // -----------------------------------------------------
        // 7. SAVE CURSOR ONLY AFTER PLAID SUCCEEDS
        // -----------------------------------------------------

        const {
          data: updatedItem,
          error: updateError,
        } = await db
          .from('plaid_items')
          .update({
            cursor: nextCursor,
            last_synced_at:
              new Date().toISOString(),
          })
          .eq('id', item.id)
          .eq('client_id', clientId)
          .is('cursor', null)
          .select('id, cursor')
          .maybeSingle();

        if (updateError) {
          throw new Error(
            updateError.message ||
              'Failed to save migration cursor.'
          );
        }

        if (!updatedItem) {
          throw new Error(
            'Plaid Item changed before its migration cursor could be saved.'
          );
        }

        results.push({
          plaid_item_database_id: item.id,
          plaid_item_id: item.plaid_item_id,
          success: true,
          cursor_saved: true,
        });
      } catch (itemError: any) {
        const errorMessage =
          itemError?.response?.data?.error_message ||
          itemError?.response?.data?.error_code ||
          itemError?.message ||
          'Unknown migration error.';

        console.error(
          '[plaid/migrate-sync-cursors] Item migration failed:',
          {
            plaidItemDatabaseId: item.id,
            plaidItemId: item.plaid_item_id,
            error:
              itemError?.response?.data ||
              itemError,
          }
        );

        results.push({
          plaid_item_database_id: item.id,
          plaid_item_id: item.plaid_item_id,
          success: false,
          cursor_saved: false,
          error: errorMessage,
        });
      }
    }

    // ---------------------------------------------------------
    // 8. RETURN AUDITABLE RESULTS
    // ---------------------------------------------------------

    const migrated = results.filter(
      (result) => result.success
    ).length;

    const failed =
      results.length - migrated;

    console.log(
      '[plaid/migrate-sync-cursors] COMPLETE',
      {
        userId: user.id,
        clientId,
        eligible: eligibleItems.length,
        migrated,
        failed,
      }
    );

    return NextResponse.json(
      {
        success: failed === 0,
        client_id: clientId,
        client_name:
          selectedClient.business_name,
        eligible: eligibleItems.length,
        migrated,
        failed,
        results,
        message:
          failed === 0
            ? 'Legacy Plaid sync cursors initialized successfully.'
            : 'Cursor migration completed with one or more failures.',
      },
      {
        status: failed === 0 ? 200 : 207,
      }
    );
  } catch (error: any) {
    console.error(
      '[plaid/migrate-sync-cursors] FAILED:',
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
          'Failed to migrate Plaid sync cursors.',
      },
      { status: 500 }
    );
  }
}