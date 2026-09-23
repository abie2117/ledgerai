// app/api/plaid/sync/route.ts

import { NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import {
  getPlaidSyncErrorMessage,
  PlaidItemSyncResult,
  syncPlaidItem,
} from '@/lib/plaid-sync';

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
    // 2. REQUIRE AN EXPLICIT CLIENT
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
            'A LedgerAI client must be selected before synchronizing transactions.',
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
        '[plaid/sync] Membership lookup failed:',
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
    // 4. VERIFY SELECTED CLIENT
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
        '[plaid/sync] Client lookup failed:',
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
    // 5. LOAD ACTIVE PLAID ITEMS
    //
    // Supports:
    // - initialized Items with a stored cursor
    // - newly connected Items with a null cursor
    //
    // Legacy fake test rows remain explicitly excluded.
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
        token_key_version,
        institution_name,
        status,
        cursor,
        last_synced_at
      `)
      .eq('client_id', clientId)
      .in('status', ['active', 'error'])
      .not('plaid_item_id', 'like', 'item_test_%');

    if (plaidItemsError) {
      console.error(
        '[plaid/sync] Plaid Item lookup failed:',
        plaidItemsError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Unable to load Plaid Items for synchronization.',
        },
        { status: 500 }
      );
    }

    if (!plaidItems || plaidItems.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'No active Plaid Items were found for this client.',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 6. SYNCHRONIZE EACH PLAID ITEM
    //
    // The financial synchronization engine now lives in
    // lib/plaid-sync.ts so manual Refresh and future Plaid
    // webhooks can share exactly the same implementation.
    // ---------------------------------------------------------

    const results: PlaidItemSyncResult[] = plaidItems
      .filter((item) => item.status === 'error')
      .map((item) => ({
        plaid_item_database_id: item.id,
        plaid_item_id: item.plaid_item_id,
        institution_name: item.institution_name || null,
        success: false,
        added: 0,
        modified: 0,
        removed: 0,
        skipped: 0,
        error_code: 'ITEM_LOGIN_REQUIRED',
        requires_reauthentication: true,
        error: 'Plaid Item requires reauthentication.',
      }));

    for (const item of plaidItems.filter(
      (candidate) => candidate.status === 'active',
    )) {
      const result = await syncPlaidItem({
        db,
        item,
      });

      results.push(result);
    }

    // ---------------------------------------------------------
    // 7. BUILD AUDITABLE RESULT
    // ---------------------------------------------------------

    const successfulItems =
      results.filter(
        (result) => result.success
      ).length;

    const failedItems =
      results.length -
      successfulItems;

    const totals = results.reduce(
      (summary, result) => {
        summary.added += result.added;
        summary.modified += result.modified;
        summary.removed += result.removed;
        summary.skipped += result.skipped;

        return summary;
      },
      {
        added: 0,
        modified: 0,
        removed: 0,
        skipped: 0,
      }
    );

    const reauthenticationRequired = results
      .filter(
        (result) => result.requires_reauthentication
      )
      .map((result) => ({
        plaid_item_database_id:
          result.plaid_item_database_id,
        plaid_item_id:
          result.plaid_item_id,
        institution_name:
          result.institution_name || null,
      }));

    const itemFailures = results
      .filter(
        (result) =>
          !result.success &&
          !result.requires_reauthentication
      )
      .map((result) => ({
        plaid_item_database_id:
          result.plaid_item_database_id,
        plaid_item_id:
          result.plaid_item_id,
        institution_name:
          result.institution_name || null,
        error_code:
          result.error_code || null,
        error:
          result.error || 'Plaid Item synchronization failed.',
      }));

    console.log(
      '[plaid/sync] COMPLETE',
      {
        userId: user.id,
        clientId,
        items: results.length,
        successfulItems,
        failedItems,
        totals,
      }
    );

    // ---------------------------------------------------------
    // 8. RETURN SAME PUBLIC RESPONSE CONTRACT
    // ---------------------------------------------------------

    return NextResponse.json(
      {
        success: failedItems === 0,
        client_id: clientId,
        client_name:
          selectedClient.business_name,
        items: results.length,
        successful_items:
          successfulItems,
        failed_items:
          failedItems,
        reauthentication_required:
          reauthenticationRequired,
        item_failures:
          itemFailures,
        totals,
        results,
        message:
          failedItems === 0
            ? 'Plaid transactions synchronized successfully.'
            : 'Plaid synchronization completed with one or more Item failures.',
      },
      {
        status:
          failedItems === 0
            ? 200
            : 207,
      }
    );
  } catch (error: any) {
    console.error(
      '[plaid/sync] FAILED:',
      error?.response?.data ||
        error?.message ||
        error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          getPlaidSyncErrorMessage(
            error
          ),
      },
      { status: 500 }
    );
  }
}