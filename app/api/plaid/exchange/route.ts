// app/api/plaid/exchange/route.ts

import { NextResponse } from 'next/server';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const configuration = new Configuration({
  basePath:
    PlaidEnvironments[
      (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) ||
        'sandbox'
    ],

  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

function serviceRole() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
      },
    }
  );
}

export async function POST(req: Request) {
  try {
    /*
     * ---------------------------------------------------------
     * 1. AUTHENTICATE CURRENT USER
     * ---------------------------------------------------------
     */

    const authClient = await createRouteHandlerClient();

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError) {
      console.error(
        '[exchange] Supabase auth error:',
        authError
      );

      return NextResponse.json(
        {
          error: 'Authentication check failed.',
          details: authError.message,
        },
        { status: 401 }
      );
    }

    if (!user) {
      console.error(
        '[exchange] No authenticated user.'
      );

      return NextResponse.json(
        {
          error: 'Not authenticated.',
        },
        { status: 401 }
      );
    }

    const userId = user.id;

    console.log(
      '[exchange] Authenticated user:',
      userId
    );

    /*
     * ---------------------------------------------------------
     * 2. READ REQUEST
     * ---------------------------------------------------------
     */

    const body = await req.json();

    const publicToken = body?.public_token;

    if (!publicToken) {
      return NextResponse.json(
        {
          error: 'Missing public_token.',
        },
        { status: 400 }
      );
    }

    /*
     * We intentionally use the authenticated Supabase user ID
     * as the owner of the connected bank.
     */
    const clientId =
      body?.client_id ||
      body?.clientId ||
      userId;

    console.log(
      '[exchange] Using client ID:',
      clientId
    );

    /*
     * ---------------------------------------------------------
     * 3. SERVICE ROLE DATABASE CLIENT
     * ---------------------------------------------------------
     */

    const db = serviceRole();

    /*
     * ---------------------------------------------------------
     * 4. EXCHANGE PLAID PUBLIC TOKEN
     * ---------------------------------------------------------
     */

    console.log(
      '[exchange] Exchanging Plaid public token...'
    );

    const exchangeResponse =
      await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });

    const accessToken =
      exchangeResponse.data.access_token;

    const itemId =
      exchangeResponse.data.item_id;

    console.log(
      '[exchange] Plaid item created:',
      itemId
    );

    /*
     * ---------------------------------------------------------
     * 5. SAVE PLAID ITEM
     * ---------------------------------------------------------
     */

    const {
      data: plaidItem,
      error: plaidItemError,
    } = await db
      .from('plaid_items')
      .upsert(
        {
          client_id: clientId,
          plaid_item_id: itemId,

          /*
           * NOTE:
           * This is existing project behavior.
           * For production, use proper encryption/key management
           * rather than simple base64 encoding.
           */
          access_token_encrypted:
            Buffer.from(accessToken).toString(
              'base64'
            ),

          status: 'active',

          last_synced_at:
            new Date().toISOString(),
        },
        {
          onConflict: 'plaid_item_id',
        }
      )
      .select('id')
      .single();

    if (plaidItemError) {
      console.error(
        '[exchange] plaid_items upsert failed:',
        plaidItemError
      );

      return NextResponse.json(
        {
          error:
            'Failed to save Plaid connection.',
          details: plaidItemError.message,
        },
        { status: 500 }
      );
    }

    if (!plaidItem?.id) {
      return NextResponse.json(
        {
          error:
            'Plaid connection was created, but the database did not return a Plaid item ID.',
        },
        { status: 500 }
      );
    }

    const plaidItemDatabaseId =
      plaidItem.id;

    console.log(
      '[exchange] Saved plaid_item:',
      plaidItemDatabaseId
    );

    /*
     * ---------------------------------------------------------
     * 6. FETCH PLAID ACCOUNTS
     * ---------------------------------------------------------
     */

    console.log(
      '[exchange] Fetching Plaid accounts...'
    );

    const accountsResponse =
      await plaidClient.accountsGet({
        access_token: accessToken,
      });

    const plaidAccounts =
      accountsResponse.data.accounts;

    console.log(
      '[exchange] Plaid accounts found:',
      plaidAccounts.length
    );

    /*
     * Map:
     *
     * Plaid account ID
     *       ↓
     * Supabase accounts.id
     *
     * This prevents transactions from getting
     * account_id = null.
     */

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
              account.official_name ||
              'Bank Account',

            mask:
              account.mask || null,

            type:
              account.type,

            subtype:
              account.subtype || null,
          },
          {
            onConflict:
              'plaid_account_id',
          }
        )
        .select(
          'id, plaid_account_id'
        )
        .single();

      if (accountError) {
        console.error(
          '[exchange] Account upsert failed:',
          accountError
        );

        continue;
      }

      if (accountRow) {
        accountIdMap.set(
          account.account_id,
          accountRow.id
        );
      }
    }

    console.log(
      '[exchange] Account mappings created:',
      accountIdMap.size
    );

    /*
     * ---------------------------------------------------------
     * 7. MAKE SURE ACCOUNTS WERE CREATED
     * ---------------------------------------------------------
     */

    if (accountIdMap.size === 0) {
      return NextResponse.json(
        {
          error:
            'Plaid connected successfully, but no bank accounts could be saved.',
        },
        { status: 500 }
      );
    }

    /*
     * ---------------------------------------------------------
     * 8. FETCH TRANSACTIONS
     * ---------------------------------------------------------
     */

    const now = new Date();

    const startDate = new Date(
      now.getFullYear(),
      now.getMonth() - 1,
      1
    )
      .toISOString()
      .split('T')[0];

    const endDate = now
      .toISOString()
      .split('T')[0];

    console.log(
      '[exchange] Fetching transactions:',
      {
        startDate,
        endDate,
      }
    );

    const transactionsResponse =
      await plaidClient.transactionsGet({
        access_token: accessToken,
        start_date: startDate,
        end_date: endDate,
      });

    const plaidTransactions =
      transactionsResponse.data.transactions;

    console.log(
      '[exchange] Plaid transactions found:',
      plaidTransactions.length
    );

    /*
     * ---------------------------------------------------------
     * 9. BUILD TRANSACTION RECORDS
     * ---------------------------------------------------------
     */

    const records = [];

    let skippedTransactions = 0;

    for (const tx of plaidTransactions) {
      const databaseAccountId =
        accountIdMap.get(
          tx.account_id
        );

      /*
       * IMPORTANT:
       *
       * accounts.id is required by the database.
       *
       * Therefore we NEVER insert:
       *
       * account_id: null
       *
       * If Plaid gives us an account we couldn't map,
       * skip that transaction and log it.
       */

      if (!databaseAccountId) {
        console.error(
          '[exchange] Skipping transaction because account mapping was not found:',
          {
            transactionId:
              tx.transaction_id,

            plaidAccountId:
              tx.account_id,

            merchant:
              tx.merchant_name ||
              tx.name,
          }
        );

        skippedTransactions++;
        continue;
      }

      records.push({
        /*
         * Current authenticated user.
         */
        user_id: userId,

        /*
         * Existing project ownership field.
         */
        client_id: clientId,

        /*
         * Required database account relationship.
         */
        account_id:
          databaseAccountId,

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
          tx.category
            ? tx.category.join(', ')
            : null,

        status:
          'pending_review',
      });
    }

    /*
     * ---------------------------------------------------------
     * 10. SAVE TRANSACTIONS
     * ---------------------------------------------------------
     */

    if (records.length > 0) {
      console.log(
        '[exchange] Saving transactions:',
        records.length
      );

      const {
        error: transactionError,
      } = await db
        .from('transactions')
        .upsert(
          records,
          {
            onConflict:
              'plaid_transaction_id',
          }
        );

      if (transactionError) {
        console.error(
          '[exchange] Transaction upsert failed:',
          transactionError
        );

        return NextResponse.json(
          {
            error:
              transactionError.message,
            code:
              transactionError.code,
            details:
              transactionError.details,
            hint:
              transactionError.hint,
          },
          { status: 500 }
        );
      }
    }

    /*
     * ---------------------------------------------------------
     * 11. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      '[exchange] ✅ Bank synchronization complete.',
      {
        userId,
        clientId,
        plaidItemId:
          plaidItemDatabaseId,
        accounts:
          accountIdMap.size,
        transactions:
          records.length,
        skippedTransactions,
      }
    );

    return NextResponse.json({
      success: true,

      user_id: userId,

      client_id: clientId,

      plaid_item_id:
        plaidItemDatabaseId,

      accounts:
        accountIdMap.size,

      transactions:
        records.length,

      skipped_transactions:
        skippedTransactions,
    });
  } catch (error: any) {
    console.error(
      '[exchange] ❌ Failed:',
      error?.response?.data ||
        error?.message ||
        error
    );

    return NextResponse.json(
      {
        error:
          error?.response?.data?.error_message ||
          error?.message ||
          'Failed to exchange Plaid token.',
      },
      { status: 500 }
    );
  }
}
