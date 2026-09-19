// app/api/plaid/exchange/route.ts

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

    /*
     * This preserves the existing storage format.
     *
     * NOTE:
     * Base64 is encoding, not encryption.
     * Access-token encryption should be upgraded separately.
     *
     * New Items begin with cursor = null.
     * A usable cursor is persisted only after a complete
     * /transactions/sync pagination cycle succeeds.
     */

    const encryptedAccessToken =
      Buffer.from(accessToken).toString('base64');

    const {
      data: plaidItem,
      error: plaidItemError,
    } = await db
      .from('plaid_items')
      .upsert(
        {
          client_id: clientId,
          plaid_item_id: plaidItemId,
          access_token_encrypted:
            encryptedAccessToken,
          status: 'active',
          cursor: null,
          last_synced_at: null,
          token_key_version: 1,
        },
        {
          onConflict: 'plaid_item_id',
        }
      )
      .select('id')
      .single();

    if (plaidItemError || !plaidItem) {
      console.error(
        '[plaid/exchange] Failed to save Plaid item:',
        plaidItemError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            plaidItemError?.message ||
            'Failed to save Plaid connection.',
        },
        { status: 500 }
      );
    }

    const plaidItemDatabaseId =
      plaidItem.id;

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
    // 10. INITIALIZE TRANSACTIONS WITH /TRANSACTIONS/SYNC
    // ---------------------------------------------------------

    /*
     * For a brand-new Item:
     *
     * - Do NOT use cursor: "now".
     * - Do NOT provide a cursor on the first request.
     * - Pull every available page.
     * - Persist the final next_cursor only after the entire
     *   pagination cycle and database mutations succeed.
     *
     * Plaid may legitimately return no transactions and an
     * empty next_cursor immediately after Link. That is not
     * treated as a failed bank connection.
     */

    let addedTransactions: any[] = [];
    let modifiedTransactions: any[] = [];
    let removedTransactions: any[] = [];

    let finalCursor = '';
    let syncCompleted = false;
    let syncAttempt = 0;

    const maxSyncAttempts = 3;

    while (
      !syncCompleted &&
      syncAttempt < maxSyncAttempts
    ) {
      syncAttempt += 1;

      addedTransactions = [];
      modifiedTransactions = [];
      removedTransactions = [];

      let requestCursor: string | undefined =
        undefined;

      let hasMore = true;

      try {
        while (hasMore) {
          const syncRequest: any = {
            access_token: accessToken,
            count: 500,
          };

          /*
           * The very first request intentionally omits cursor.
           * Subsequent pagination requests use next_cursor.
           */

          if (requestCursor) {
            syncRequest.cursor =
              requestCursor;
          }

          const syncResponse =
            await plaidClient.transactionsSync(
              syncRequest
            );

          const syncData =
            syncResponse.data;

          addedTransactions.push(
            ...(syncData.added || [])
          );

          modifiedTransactions.push(
            ...(syncData.modified || [])
          );

          removedTransactions.push(
            ...(syncData.removed || [])
          );

          finalCursor =
            syncData.next_cursor || '';

          hasMore =
            Boolean(syncData.has_more);

          if (hasMore) {
            /*
             * A next cursor is required to retrieve the
             * following page.
             */

            if (!finalCursor) {
              throw new Error(
                'Plaid returned has_more=true without a next_cursor.'
              );
            }

            requestCursor =
              finalCursor;
          }
        }

        syncCompleted = true;
      } catch (syncError: any) {
        const errorCode =
          getPlaidErrorCode(syncError);

        if (
          errorCode ===
            'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' &&
          syncAttempt < maxSyncAttempts
        ) {
          console.warn(
            '[plaid/exchange] Transactions changed during initial pagination. Restarting from the beginning.',
            {
              plaidItemId,
              attempt: syncAttempt,
            }
          );

          continue;
        }

        console.error(
          '[plaid/exchange] Initial transaction sync failed:',
          syncError?.response?.data ||
            syncError
        );

        /*
         * The bank connection itself is valid even if Plaid
         * transaction history is not ready yet.
         *
         * Keep cursor null so a future initialization attempt
         * can start from the beginning.
         */

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
    }

    if (!syncCompleted) {
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

    // ---------------------------------------------------------
    // 11. BUILD ADDED TRANSACTION RECORDS
    // ---------------------------------------------------------

    const addedRecords =
      addedTransactions
        .map((tx) => {
          const localAccountId =
            accountIdMap.get(
              tx.account_id
            );

          if (!localAccountId) {
            console.warn(
              '[plaid/exchange] Skipping added transaction with unknown account:',
              {
                transactionId:
                  tx.transaction_id,
                plaidAccountId:
                  tx.account_id,
              }
            );

            return null;
          }

          return {
            account_id:
              localAccountId,

            client_id:
              clientId,

            plaid_transaction_id:
              tx.transaction_id,

            posted_date:
              tx.date,

            amount:
              tx.amount,

            merchant_name:
              tx.merchant_name ||
              tx.name ||
              'Unknown Merchant',

            raw_plaid_category:
              Array.isArray(tx.category)
                ? tx.category.join(', ')
                : null,

            status:
              'pending_review',
          };
        })
        .filter(
          (
            record
          ): record is NonNullable<
            typeof record
          > =>
            record !== null
        );

    // ---------------------------------------------------------
    // 12. SAVE ADDED TRANSACTIONS
    // ---------------------------------------------------------

    /*
     * ignoreDuplicates protects any LedgerAI-owned fields if
     * Plaid unexpectedly returns a transaction ID that is
     * already stored.
     */

    if (addedRecords.length > 0) {
      const {
        error: addedError,
      } = await db
        .from('transactions')
        .upsert(
          addedRecords,
          {
            onConflict:
              'plaid_transaction_id',
            ignoreDuplicates: true,
          }
        );

      if (addedError) {
        console.error(
          '[plaid/exchange] Added transaction save failed:',
          addedError
        );

        return NextResponse.json(
          {
            success: false,
            error:
              addedError.message,
          },
          { status: 500 }
        );
      }
    }

    // ---------------------------------------------------------
    // 13. APPLY MODIFIED TRANSACTIONS
    // ---------------------------------------------------------

    /*
     * Only Plaid-owned fields are updated.
     *
     * We intentionally preserve:
     * - ai_category_id
     * - ai_confidence
     * - category
     * - status
     * - client_name
     * - user_id
     */

    for (const tx of modifiedTransactions) {
      const localAccountId =
        accountIdMap.get(
          tx.account_id
        );

      if (!localAccountId) {
        console.warn(
          '[plaid/exchange] Skipping modified transaction with unknown account:',
          {
            transactionId:
              tx.transaction_id,
            plaidAccountId:
              tx.account_id,
          }
        );

        continue;
      }

      const {
        error: modifiedError,
      } = await db
        .from('transactions')
        .update({
          account_id:
            localAccountId,

          posted_date:
            tx.date,

          amount:
            tx.amount,

          merchant_name:
            tx.merchant_name ||
            tx.name ||
            'Unknown Merchant',

          raw_plaid_category:
            Array.isArray(tx.category)
              ? tx.category.join(', ')
              : null,

          updated_at:
            new Date().toISOString(),
        })
        .eq(
          'client_id',
          clientId
        )
        .eq(
          'plaid_transaction_id',
          tx.transaction_id
        );

      if (modifiedError) {
        console.error(
          '[plaid/exchange] Modified transaction update failed:',
          {
            transactionId:
              tx.transaction_id,
            error:
              modifiedError,
          }
        );

        return NextResponse.json(
          {
            success: false,
            error:
              modifiedError.message,
          },
          { status: 500 }
        );
      }
    }

    // ---------------------------------------------------------
    // 14. APPLY REMOVED TRANSACTIONS
    // ---------------------------------------------------------

    /*
     * The current LedgerAI transaction schema has no
     * soft-delete state for Plaid removals.
     *
     * Therefore removed Plaid transactions are physically
     * deleted, matching the permanent /api/plaid/sync route.
     */

    for (const removed of removedTransactions) {
      if (!removed?.transaction_id) {
        continue;
      }

      const {
        error: removedError,
      } = await db
        .from('transactions')
        .delete()
        .eq(
          'client_id',
          clientId
        )
        .eq(
          'plaid_transaction_id',
          removed.transaction_id
        );

      if (removedError) {
        console.error(
          '[plaid/exchange] Removed transaction delete failed:',
          {
            transactionId:
              removed.transaction_id,
            error:
              removedError,
          }
        );

        return NextResponse.json(
          {
            success: false,
            error:
              removedError.message,
          },
          { status: 500 }
        );
      }
    }

    // ---------------------------------------------------------
    // 15. PERSIST FINAL CURSOR + LAST SYNC TIME
    // ---------------------------------------------------------

    /*
     * Plaid documents that next_cursor may be an empty string
     * when transaction data is not yet available.
     *
     * Our database cursor column is nullable, so an empty
     * Plaid cursor remains null. This allows initialization to
     * be retried later from the beginning.
     */

    const cursorToStore =
      finalCursor || null;

    const syncTimestamp =
      new Date().toISOString();

    const {
      error: cursorUpdateError,
    } = await db
      .from('plaid_items')
      .update({
        cursor:
          cursorToStore,
        status:
          'active',
        last_synced_at:
          syncTimestamp,
      })
      .eq(
        'id',
        plaidItemDatabaseId
      );

    if (cursorUpdateError) {
      console.error(
        '[plaid/exchange] Failed to persist initial sync cursor:',
        cursorUpdateError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            cursorUpdateError.message,
        },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------
    // 16. SUCCESS
    // ---------------------------------------------------------

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
          addedTransactions.length,

        modified:
          modifiedTransactions.length,

        removed:
          removedTransactions.length,

        savedTransactions:
          addedRecords.length,

        cursorInitialized:
          Boolean(cursorToStore),

        syncAttempts:
          syncAttempt,
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
        addedTransactions.length,

      added:
        addedTransactions.length,

      modified:
        modifiedTransactions.length,

      removed:
        removedTransactions.length,

      count:
        addedRecords.length,

      cursor_initialized:
        Boolean(cursorToStore),

      message:
        cursorToStore
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