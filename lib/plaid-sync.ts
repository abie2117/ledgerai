import { asErrorDetails } from '@/lib/error-details';
// lib/plaid-sync.ts

import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  type Transaction,
  type RemovedTransaction,
  type TransactionsSyncRequest,
} from 'plaid';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readPlaidAccessToken } from './plaid-token-storage';
import { categorizeWithLocalRules } from './categorization';
import { detectDuplicateCandidates } from './duplicate-detection';
import { detectRecurringTransactionCandidates } from './recurring-detection';

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

function getPlaidErrorCode(error: unknown) {
  const details = asErrorDetails(error);
  return (
    details.response?.data?.error_code ||
    details.error_code ||
    null
  );
}

export function getPlaidSyncErrorMessage(error: unknown) {
  const details = asErrorDetails(error);
  return (
    details.response?.data?.error_message ||
    details.response?.data?.error_code ||
    details.message ||
    'Unknown Plaid synchronization error.'
  );
}

type ProviderExceptionEventType = 'modified' | 'removed' | 'reappeared';

async function applyOrCaptureProviderChange({
  db,
  item,
  clientId,
  plaidTransactionId,
  eventType,
  accountId = null,
  postedDate = null,
  amount = null,
  merchantName = null,
  rawPlaidCategory = null,
}: {
  db: SupabaseClient;
  item: PlaidItemForSync;
  clientId: string;
  plaidTransactionId: string;
  eventType: ProviderExceptionEventType;
  accountId?: string | null;
  postedDate?: string | null;
  amount?: number | null;
  merchantName?: string | null;
  rawPlaidCategory?: string | null;
}) {
  const { data, error } = await db.rpc(
    'apply_or_capture_provider_transaction_change',
    {
      p_client_id: clientId,
      p_plaid_item_id: item.id,
      p_plaid_transaction_id: plaidTransactionId,
      p_event_type: eventType,
      p_account_id: accountId,
      p_posted_date: postedDate,
      p_amount: amount,
      p_merchant_name: merchantName,
      p_raw_plaid_category: rawPlaidCategory,
    }
  );

  if (error) {
    throw new Error(
      error.message ||
        `Failed to apply or capture provider ${eventType} event for transaction ${plaidTransactionId}.`
    );
  }

  return Array.isArray(data) ? data[0] || null : data;
}

export async function syncPlaidItem({
  db,
  item,
}: {
  db: SupabaseClient;
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

    let addedTransactions: Transaction[] = [];
    let modifiedTransactions: Transaction[] = [];
    let removedTransactions: RemovedTransaction[] = [];
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
          const syncRequest: TransactionsSyncRequest = {
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
      } catch (paginationError) {
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

    const addedRecords: {
      account_id: string;
      client_id: string;
      plaid_transaction_id: string;
      posted_date: string;
      amount: number;
      merchant_name: string;
      raw_plaid_category: string | null;
      status: string;
    }[] = [];
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
    // New Plaid IDs are inserted normally. Existing soft-removed IDs are
    // reappearance events handled by the atomic database boundary.
    // ---------------------------------------------------------

    for (const addedRecord of addedRecords) {
      const {
        data: existingTransaction,
        error: existingTransactionError,
      } = await db
        .from('transactions')
        .select('id, plaid_removed_at')
        .eq(
          'plaid_transaction_id',
          addedRecord.plaid_transaction_id
        )
        .eq('client_id', clientId)
        .maybeSingle();

      if (existingTransactionError) {
        throw new Error(
          existingTransactionError.message ||
            `Failed to inspect added transaction ${addedRecord.plaid_transaction_id}.`
        );
      }

      if (!existingTransaction) {
        const { error: addedError } = await db
          .from('transactions')
          .insert(addedRecord);

        if (addedError) {
          throw new Error(
            addedError.message ||
              `Failed to save added transaction ${addedRecord.plaid_transaction_id}.`
          );
        }

        continue;
      }

      if (!existingTransaction.plaid_removed_at) {
        continue;
      }

      await applyOrCaptureProviderChange({
        db,
        item,
        clientId,
        plaidTransactionId:
          addedRecord.plaid_transaction_id,
        eventType: 'reappeared',
        accountId: addedRecord.account_id,
        postedDate: addedRecord.posted_date,
        amount: addedRecord.amount,
        merchantName: addedRecord.merchant_name,
        rawPlaidCategory:
          addedRecord.raw_plaid_category,
      });
    }

    // ---------------------------------------------------------
    // 5. APPLY MODIFIED TRANSACTIONS
    //
    // The database locks the transaction and atomically chooses whether
    // provider-owned state can be applied or must become review evidence.
    // ---------------------------------------------------------

    for (const tx of modifiedTransactions) {
      const localAccountId =
        accountIdMap.get(tx.account_id);

      if (!localAccountId) {
        console.warn(
          '[plaid-sync] Skipping modified transaction with unknown account:',
          {
            transactionId: tx.transaction_id,
            plaidAccountId: tx.account_id,
          }
        );

        skippedTransactions += 1;
        continue;
      }

      const { data: existingTransaction, error: lookupError } =
        await db
          .from('transactions')
          .select('id')
          .eq('plaid_transaction_id', tx.transaction_id)
          .eq('client_id', clientId)
          .maybeSingle();

      if (lookupError) {
        throw new Error(
          lookupError.message ||
            `Failed to inspect transaction ${tx.transaction_id} before applying its provider modification.`
        );
      }

      if (!existingTransaction) {
        skippedTransactions += 1;
        continue;
      }

      await applyOrCaptureProviderChange({
        db,
        item,
        clientId,
        plaidTransactionId: tx.transaction_id,
        eventType: 'modified',
        accountId: localAccountId,
        postedDate: tx.date,
        amount: tx.amount,
        merchantName:
          tx.merchant_name ||
          tx.name ||
          'Unknown Merchant',
        rawPlaidCategory:
          Array.isArray(tx.category)
            ? tx.category.join(', ')
            : null,
      });
    }

    // ---------------------------------------------------------
    // 6. APPLY REMOVED TRANSACTIONS
    //
    // Preserve history. The atomic database boundary either soft-removes
    // an unjournaled transaction or captures evidence for an active journal.
    // ---------------------------------------------------------

    const removedIds = Array.from(
      new Set(
        removedTransactions
          .map((removed) => removed.transaction_id)
          .filter(
            (transactionId): transactionId is string =>
              typeof transactionId === 'string' &&
              transactionId.length > 0
          )
      )
    );

    for (const plaidTransactionId of removedIds) {
      const { data: existingTransaction, error: lookupError } =
        await db
          .from('transactions')
          .select('id')
          .eq('plaid_transaction_id', plaidTransactionId)
          .eq('client_id', clientId)
          .maybeSingle();

      if (lookupError) {
        throw new Error(
          lookupError.message ||
            `Failed to inspect removed Plaid transaction ${plaidTransactionId}.`
        );
      }

      if (!existingTransaction) {
        skippedTransactions += 1;
        continue;
      }

      await applyOrCaptureProviderChange({
        db,
        item,
        clientId,
        plaidTransactionId,
        eventType: 'removed',
      });
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

    // ---------------------------------------------------------
    // 8. CATEGORIZE PENDING TRANSACTIONS
    //
    // Categorization runs only after bank ingestion and the cursor
    // commit succeed. A categorization failure must never make a
    // successful Plaid sync look unsuccessful.
    //
    // The engine assigns categories and provenance, but does not
    // confirm transactions. Uncertain bookkeeping remains available
    // for exception review.
    // ---------------------------------------------------------

    try {
      const categorizationResult =
        await categorizeWithLocalRules(
          clientId
        );

      console.log(
        '[plaid-sync] Automatic categorization complete:',
        {
          clientId,
          categorized:
            categorizationResult.categorized,
          leftForReview:
            categorizationResult.skipped,
        }
      );
    } catch (categorizationError) {
      console.warn(
        '[plaid-sync] Bank sync succeeded, but automatic categorization could not complete:',
        asErrorDetails(categorizationError).message ||
          categorizationError
      );
    }

    // ---------------------------------------------------------
    // 9. DETECT SUSPECTED DUPLICATES
    //
    // Evidence only: never mutates transaction financial state.
    // A detector failure cannot make a successful bank sync fail.
    // ---------------------------------------------------------

    try {
      const duplicateResult =
        await detectDuplicateCandidates(
          db,
          clientId
        );

      console.log(
        '[plaid-sync] Duplicate candidate detection complete:',
        {
          clientId,
          scanned:
            duplicateResult.scanned,
          candidates:
            duplicateResult.candidates,
        }
      );
    } catch (duplicateError) {
      console.warn(
        '[plaid-sync] Bank sync succeeded, but duplicate candidate detection could not complete:',
        asErrorDetails(duplicateError).message ||
          duplicateError
      );
    }

    // ---------------------------------------------------------
    // 10. DETECT RECURRING VENDOR-SPEND EVIDENCE
    //
    // Evidence only: never creates bills, payments, journals, or
    // transaction confirmations. A detector failure cannot make a
    // successful bank sync fail.
    // ---------------------------------------------------------

    try {
      const recurringResult =
        await detectRecurringTransactionCandidates(
          db,
          clientId
        );

      console.log(
        '[plaid-sync] Recurring candidate detection complete:',
        {
          clientId,
          scanned:
            recurringResult.scanned,
          eligible:
            recurringResult.eligible,
          candidates:
            recurringResult.candidates,
        }
      );
    } catch (recurringError) {
      console.warn(
        '[plaid-sync] Bank sync succeeded, but recurring candidate detection could not complete:',
        asErrorDetails(recurringError).message ||
          recurringError
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
  } catch (itemError) {
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
          asErrorDetails(itemError).response?.data ||
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
