// lib/plaid-sync.ts

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { readPlaidAccessToken } from './plaid-token-storage';

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

export type PlaidItemForSync = {
  id: string;
  client_id: string;
  plaid_item_id: string;
  access_token_encrypted: unknown;
  token_key_version: number;
  institution_name?: string | null;
  status?: string | null;
  cursor?: string | null;
  last_synced_at?: string | null;
};

export type PlaidItemSyncResult = {
  plaid_item_database_id: string;
  plaid_item_id: string;
  success: boolean;
  added: number;
  modified: number;
  removed: number;
  skipped: number;
  institution_name?: string | null;
  error_code?: string | null;
  requires_reauthentication?: boolean;
  error?: string;
};

function getPlaidErrorCode(error: any) {
  return (
    error?.response?.data?.error_code ||
    error?.error_code ||
    null
  );
}

export function getPlaidSyncErrorMessage(error: any) {
  return (
    error?.response?.data?.error_message ||
    error?.response?.data?.error_code ||
    error?.message ||
    'Unknown Plaid synchronization error.'
  );
}

export async function syncPlaidItem({
  db,
  item,
}: {
  db: any;
  item: PlaidItemForSync;
}): Promise<PlaidItemSyncResult> {
  const clientId = item.client_id;

  try {
    const accessToken = await readPlaidAccessToken(item);

    // ---------------------------------------------------------
    // 1. LOAD LOCAL ACCOUNT MAP
    // ---------------------------------------------------------

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

    // ---------------------------------------------------------
    // 2. RETRIEVE ALL PLAID SYNC PAGES
    //
    // No database transaction mutations happen until all pages
    // have been retrieved successfully.
    //
    // If Plaid reports a mutation during pagination, discard the
    // accumulated pages and restart from the original cursor.
    // ---------------------------------------------------------

    const originalCursor =
      typeof item.cursor === 'string' &&
      item.cursor.length > 0
        ? item.cursor
        : null;

    let addedTransactions: any[] = [];
    let modifiedTransactions: any[] = [];
    let removedTransactions: any[] = [];
    let finalCursor = originalCursor || '';

    const maxPaginationRestarts = 3;
    let paginationRestartCount = 0;

    while (true) {
      let pageCursor: string | null =
        originalCursor;

      let hasMore = true;

      addedTransactions = [];
      modifiedTransactions = [];
      removedTransactions = [];
      finalCursor = originalCursor || '';

      try {
        while (hasMore) {
          const syncRequest: any = {
            access_token: accessToken,
            count: 500,
          };

          // New Items omit cursor on their first sync.
          // Initialized Items continue from the stored cursor.
          if (pageCursor) {
            syncRequest.cursor = pageCursor;
          }

          const syncResponse =
            await plaidClient.transactionsSync(
              syncRequest
            );

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
            '[plaid-sync] Restarting pagination from original cursor:',
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

    if (typeof finalCursor !== 'string') {
      throw new Error(
        'Plaid did not return a valid sync cursor.'
      );
    }

    // ---------------------------------------------------------
    // 3. BUILD ADDED TRANSACTIONS
    //
    // LedgerAI-owned categorization/review fields are not
    // populated or overwritten here.
    // ---------------------------------------------------------

    const addedRecords: any[] = [];
    let skippedTransactions = 0;

    for (const tx of addedTransactions) {
      const localAccountId =
        accountIdMap.get(
          tx.account_id
        );

      if (!localAccountId) {
        console.warn(
          '[plaid-sync] Skipping added transaction with unknown account:',
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

    // ---------------------------------------------------------
    // 4. APPLY ADDED TRANSACTIONS
    //
    // Existing transaction IDs are ignored so a Plaid "added"
    // event cannot overwrite LedgerAI-owned bookkeeping fields.
    // ---------------------------------------------------------

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

    // ---------------------------------------------------------
    // 5. APPLY MODIFIED TRANSACTIONS
    //
    // Update only Plaid-owned fields.
    // Do not touch categorization, confidence, or review state.
    // ---------------------------------------------------------

    for (const tx of modifiedTransactions) {
      const localAccountId =
        accountIdMap.get(
          tx.account_id
        );

      if (!localAccountId) {
        console.warn(
          '[plaid-sync] Skipping modified transaction with unknown account:',
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

    // ---------------------------------------------------------
    // 6. APPLY REMOVED TRANSACTIONS
    //
    // LedgerAI currently has no transaction soft-delete field,
    // so Plaid removals are physically deleted.
    // ---------------------------------------------------------

    const removedIds = Array.from(
      new Set(
        removedTransactions
          .map(
            (removed) =>
              removed.transaction_id
          )
          .filter(
            (
              transactionId
            ): transactionId is string =>
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

    // ---------------------------------------------------------
    // 7. COMMIT FINAL CURSOR
    //
    // Advance only after all database mutations succeed.
    //
    // The old-cursor condition protects against concurrent sync
    // requests silently overwriting each other's cursor.
    // ---------------------------------------------------------

    let cursorUpdateQuery = db
      .from('plaid_items')
      .update({
        cursor: finalCursor || null,
        last_synced_at:
          new Date().toISOString(),
      })
      .eq('id', item.id)
      .eq('client_id', clientId);

    cursorUpdateQuery = originalCursor
      ? cursorUpdateQuery.eq(
          'cursor',
          originalCursor
        )
      : cursorUpdateQuery.is(
          'cursor',
          null
        );

    const {
      data: updatedItem,
      error: cursorUpdateError,
    } = await cursorUpdateQuery
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

    return {
      plaid_item_database_id:
        item.id,
      plaid_item_id:
        item.plaid_item_id,
      institution_name:
        item.institution_name || null,
      success: true,
      added:
        addedTransactions.length,
      modified:
        modifiedTransactions.length,
      removed:
        removedTransactions.length,
      skipped:
        skippedTransactions,
    };
  } catch (itemError: any) {
    const errorCode = getPlaidErrorCode(itemError);
    const errorMessage =
      getPlaidSyncErrorMessage(
        itemError
      );

    if (errorCode === 'ITEM_LOGIN_REQUIRED') {
      const { error: statusError } = await db
        .from('plaid_items')
        .update({ status: 'error' })
        .eq('id', item.id)
        .eq('client_id', clientId);

      if (statusError) {
        console.error(
          '[plaid-sync] Failed to mark Plaid Item as requiring reauthentication:',
          statusError
        );
      }
    }

    console.error(
      '[plaid-sync] Item synchronization failed:',
      {
        plaidItemDatabaseId:
          item.id,
        plaidItemId:
          item.plaid_item_id,
        clientId,
        error:
          itemError?.response?.data ||
          itemError,
      }
    );

    return {
      plaid_item_database_id:
        item.id,
      plaid_item_id:
        item.plaid_item_id,
      success: false,
      added: 0,
      modified: 0,
      removed: 0,
      skipped: 0,
      institution_name:
        item.institution_name || null,
      error_code:
        errorCode,
      requires_reauthentication:
        errorCode === 'ITEM_LOGIN_REQUIRED',
      error: errorMessage,
    };
  }
}