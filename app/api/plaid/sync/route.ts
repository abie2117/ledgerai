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

function decodeStoredAccessToken(storedToken: unknown) {
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
      (storedToken as { data: number[] }).data
    ).toString('utf8');
  } else {
    throw new Error(
      'Unsupported access-token storage format.'
    );
  }

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

  return accessToken;
}

function getPlaidErrorCode(error: any) {
  return (
    error?.response?.data?.error_code ||
    error?.error_code ||
    null
  );
}

function getPlaidErrorMessage(error: any) {
  return (
    error?.response?.data?.error_message ||
    error?.response?.data?.error_code ||
    error?.message ||
    'Unknown Plaid synchronization error.'
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
    // 5. LOAD ACTIVE, MIGRATED PLAID ITEMS
    //
    // Permanent sync intentionally requires a real stored
    // cursor. Legacy Items must first pass through the migration
    // route. This prevents this endpoint from guessing whether
    // a null cursor represents an old or newly connected Item.
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
      .not('cursor', 'is', null);

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
            'No sync-ready Plaid Items were found for this client.',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 6. PROCESS EACH PLAID ITEM
    // ---------------------------------------------------------

    const results: Array<{
      plaid_item_database_id: string;
      plaid_item_id: string;
      success: boolean;
      added: number;
      modified: number;
      removed: number;
      skipped: number;
      error?: string;
    }> = [];

    for (const item of plaidItems) {
      try {
        const accessToken =
          decodeStoredAccessToken(
            item.access_token_encrypted
          );

        // -----------------------------------------------------
        // 7. LOAD LOCAL ACCOUNT MAP FOR THIS ITEM
        // -----------------------------------------------------

        const {
          data: localAccounts,
          error: accountsError,
        } = await db
          .from('accounts')
          .select('id, plaid_account_id')
          .eq('plaid_item_id', item.id);

        if (accountsError) {
          throw new Error(
            accountsError.message ||
              'Failed to load LedgerAI accounts.'
          );
        }

        const accountIdMap = new Map<string, string>();

        for (const account of localAccounts || []) {
          if (
            account.plaid_account_id &&
            account.id
          ) {
            accountIdMap.set(
              account.plaid_account_id,
              account.id
            );
          }
        }

        if (accountIdMap.size === 0) {
          throw new Error(
            'No LedgerAI accounts exist for this Plaid Item.'
          );
        }

        // -----------------------------------------------------
        // 8. RETRIEVE ALL SYNC PAGES
        //
        // Nothing is written to Supabase until every page has
        // been successfully retrieved.
        //
        // If Plaid reports a mutation during pagination, throw
        // away the accumulated pages and restart from the
        // original stored cursor.
        // -----------------------------------------------------

        const originalCursor = item.cursor as string;

        let addedTransactions: any[] = [];
        let modifiedTransactions: any[] = [];
        let removedTransactions: any[] = [];
        let finalCursor = originalCursor;

        const maxPaginationRestarts = 3;
        let paginationRestartCount = 0;

        while (true) {
          let pageCursor = originalCursor;
          let hasMore = true;

          addedTransactions = [];
          modifiedTransactions = [];
          removedTransactions = [];
          finalCursor = originalCursor;

          try {
            while (hasMore) {
              const syncResponse =
                await plaidClient.transactionsSync({
                  access_token: accessToken,
                  cursor: pageCursor,
                  count: 500,
                });

              const data = syncResponse.data;

              addedTransactions.push(
                ...(data.added || [])
              );

              modifiedTransactions.push(
                ...(data.modified || [])
              );

              removedTransactions.push(
                ...(data.removed || [])
              );

              finalCursor = data.next_cursor;
              pageCursor = data.next_cursor;
              hasMore = data.has_more;
            }

            break;
          } catch (paginationError: any) {
            const errorCode =
              getPlaidErrorCode(
                paginationError
              );

            if (
              errorCode ===
                'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' &&
              paginationRestartCount <
                maxPaginationRestarts
            ) {
              paginationRestartCount += 1;

              console.warn(
                '[plaid/sync] Restarting pagination from original cursor:',
                {
                  plaidItemId:
                    item.plaid_item_id,
                  attempt:
                    paginationRestartCount,
                }
              );

              continue;
            }

            throw paginationError;
          }
        }

        if (
          !finalCursor ||
          typeof finalCursor !== 'string'
        ) {
          throw new Error(
            'Plaid did not return a valid sync cursor.'
          );
        }

        // -----------------------------------------------------
        // 9. BUILD ADDED TRANSACTIONS
        //
        // New records receive LedgerAI's normal default review
        // state. We deliberately do not populate or overwrite
        // AI/category fields here.
        // -----------------------------------------------------

        const addedRecords: any[] = [];
        let skippedTransactions = 0;

        for (const tx of addedTransactions) {
          const localAccountId =
            accountIdMap.get(
              tx.account_id
            );

          if (!localAccountId) {
            console.warn(
              '[plaid/sync] Skipping added transaction with unknown account:',
              {
                transactionId:
                  tx.transaction_id,
                plaidAccountId:
                  tx.account_id,
              }
            );

            skippedTransactions += 1;
            continue;
          }

          addedRecords.push({
            account_id: localAccountId,
            client_id: clientId,
            plaid_transaction_id:
              tx.transaction_id,
            posted_date: tx.date,
            amount: tx.amount,
            merchant_name:
              tx.merchant_name ||
              tx.name ||
              'Unknown Merchant',
            raw_plaid_category:
              Array.isArray(tx.category)
                ? tx.category.join(', ')
                : null,
            status: 'pending_review',
          });
        }

        // -----------------------------------------------------
        // 10. APPLY ADDED TRANSACTIONS SAFELY
        //
        // ignoreDuplicates prevents an "added" event from
        // overwriting LedgerAI-owned categorization/review
        // fields if that Plaid transaction already exists.
        // -----------------------------------------------------

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
            throw new Error(
              addedError.message ||
                'Failed to save added transactions.'
            );
          }
        }

        // -----------------------------------------------------
        // 11. APPLY MODIFIED TRANSACTIONS
        //
        // Update ONLY Plaid-owned fields. We intentionally do
        // not touch:
        // ai_category_id
        // ai_confidence
        // status
        // category
        // client_name
        // user_id
        // -----------------------------------------------------

        for (const tx of modifiedTransactions) {
          const localAccountId =
            accountIdMap.get(
              tx.account_id
            );

          if (!localAccountId) {
            console.warn(
              '[plaid/sync] Skipping modified transaction with unknown account:',
              {
                transactionId:
                  tx.transaction_id,
                plaidAccountId:
                  tx.account_id,
              }
            );

            skippedTransactions += 1;
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
              'plaid_transaction_id',
              tx.transaction_id
            )
            .eq(
              'client_id',
              clientId
            );

          if (modifiedError) {
            throw new Error(
              modifiedError.message ||
                `Failed to update transaction ${tx.transaction_id}.`
            );
          }
        }

        // -----------------------------------------------------
        // 12. APPLY REMOVED TRANSACTIONS
        //
        // Current LedgerAI schema has no soft-delete field and
        // status cannot be "removed", so Plaid removals are
        // physically deleted.
        // -----------------------------------------------------

        const removedIds = Array.from(
          new Set(
            removedTransactions
              .map(
                (removed) =>
                  removed.transaction_id
              )
              .filter(
                (transactionId):
                  transactionId is string =>
                    typeof transactionId ===
                      'string' &&
                    transactionId.length > 0
              )
          )
        );

        if (removedIds.length > 0) {
          const {
            error: removedError,
          } = await db
            .from('transactions')
            .delete()
            .eq(
              'client_id',
              clientId
            )
            .in(
              'plaid_transaction_id',
              removedIds
            );

          if (removedError) {
            throw new Error(
              removedError.message ||
                'Failed to remove deleted Plaid transactions.'
            );
          }
        }

        // -----------------------------------------------------
        // 13. COMMIT FINAL CURSOR
        //
        // Cursor is advanced only after every database mutation
        // above succeeds.
        //
        // Matching the old cursor also protects against two
        // concurrent sync requests silently overwriting each
        // other's cursor.
        // -----------------------------------------------------

        const {
          data: updatedItem,
          error: cursorUpdateError,
        } = await db
          .from('plaid_items')
          .update({
            cursor: finalCursor,
            last_synced_at:
              new Date().toISOString(),
          })
          .eq('id', item.id)
          .eq('client_id', clientId)
          .eq('cursor', originalCursor)
          .select('id, cursor')
          .maybeSingle();

        if (cursorUpdateError) {
          throw new Error(
            cursorUpdateError.message ||
              'Failed to save the final Plaid sync cursor.'
          );
        }

        if (!updatedItem) {
          throw new Error(
            'The Plaid Item cursor changed during synchronization. The final cursor was not overwritten.'
          );
        }

        results.push({
          plaid_item_database_id:
            item.id,
          plaid_item_id:
            item.plaid_item_id,
          success: true,
          added:
            addedTransactions.length,
          modified:
            modifiedTransactions.length,
          removed:
            removedTransactions.length,
          skipped:
            skippedTransactions,
        });
      } catch (itemError: any) {
        const errorMessage =
          getPlaidErrorMessage(
            itemError
          );

        console.error(
          '[plaid/sync] Item synchronization failed:',
          {
            plaidItemDatabaseId:
              item.id,
            plaidItemId:
              item.plaid_item_id,
            error:
              itemError?.response?.data ||
              itemError,
          }
        );

        results.push({
          plaid_item_database_id:
            item.id,
          plaid_item_id:
            item.plaid_item_id,
          success: false,
          added: 0,
          modified: 0,
          removed: 0,
          skipped: 0,
          error: errorMessage,
        });
      }
    }

    // ---------------------------------------------------------
    // 14. RETURN AUDITABLE RESULT
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
        summary.modified +=
          result.modified;
        summary.removed +=
          result.removed;
        summary.skipped +=
          result.skipped;

        return summary;
      },
      {
        added: 0,
        modified: 0,
        removed: 0,
        skipped: 0,
      }
    );

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
          getPlaidErrorMessage(
            error
          ),
      },
      { status: 500 }
    );
  }
}