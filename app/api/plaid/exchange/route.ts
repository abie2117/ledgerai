// app/api/plaid/exchange/route.ts

import { NextResponse } from 'next/server';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const plaidEnv =
  (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) || 'sandbox';

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
    // 1. AUTHENTICATE USER
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

    const userId = user.id;

    console.log(
      '[plaid/exchange] Authenticated LedgerAI user:',
      userId
    );

    // ---------------------------------------------------------
    // 2. READ PUBLIC TOKEN
    // ---------------------------------------------------------

    const body = await req.json();

    const publicToken = body?.public_token;

    if (!publicToken) {
      return NextResponse.json(
        {
          success: false,
          error: 'Missing public_token',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 3. EXCHANGE PUBLIC TOKEN FOR ACCESS TOKEN
    // ---------------------------------------------------------

    const exchangeResponse =
      await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });

    const accessToken =
      exchangeResponse.data.access_token;

    const plaidItemId =
      exchangeResponse.data.item_id;

    console.log(
      '[plaid/exchange] Plaid item received:',
      plaidItemId
    );

    // ---------------------------------------------------------
    // 4. CREATE SERVER-SIDE SUPABASE CLIENT
    // ---------------------------------------------------------

    const db = createServiceRoleClient();

    // ---------------------------------------------------------
    // 5. GET PLAID ACCOUNTS
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

    console.log(
      `[plaid/exchange] Plaid returned ${plaidAccounts.length} accounts`
    );

    // ---------------------------------------------------------
    // 6. SAVE PLAID ITEM
    // ---------------------------------------------------------
    //
    // Your plaid_items.client_id column is UUID NOT NULL.
    // We use the authenticated LedgerAI user's UUID.
    //
    // token_key_version is also NOT NULL, so it is supplied here.
    //
    // ---------------------------------------------------------

    const encryptedAccessToken =
      Buffer.from(accessToken).toString('base64');

    const { data: plaidItem, error: plaidItemError } =
      await db
        .from('plaid_items')
        .upsert(
          {
            client_id: userId,
            plaid_item_id: plaidItemId,
            access_token_encrypted: encryptedAccessToken,
            institution_name:
              body?.institution_name || null,
            status: 'active',
            last_synced_at:
              new Date().toISOString(),
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
        '[plaid/exchange] Failed to save plaid_items row:',
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

    console.log(
      '[plaid/exchange] Plaid item saved:',
      plaidItemDatabaseId
    );

    // ---------------------------------------------------------
    // 7. CREATE / UPDATE BANK ACCOUNTS
    // ---------------------------------------------------------

    const accountIdMap =
      new Map<string, string>();

    for (const plaidAccount of plaidAccounts) {
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
              plaidAccount.account_id,

            name:
              plaidAccount.name ||
              'Plaid Account',

            mask:
              plaidAccount.mask || null,

            type:
              plaidAccount.type || null,

            subtype:
              plaidAccount.subtype || null,
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

      if (accountError || !accountRow) {
        console.error(
          '[plaid/exchange] Failed to save account:',
          {
            plaidAccountId:
              plaidAccount.account_id,
            error: accountError,
          }
        );

        continue;
      }

      accountIdMap.set(
        plaidAccount.account_id,
        accountRow.id
      );

      console.log(
        '[plaid/exchange] Account mapped:',
        plaidAccount.account_id,
        '=>',
        accountRow.id
      );
    }

    // ---------------------------------------------------------
    // 8. VERIFY ACCOUNT MAPPING
    // ---------------------------------------------------------

    if (accountIdMap.size === 0) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Plaid connected, but LedgerAI could not save any bank accounts.',
        },
        { status: 500 }
      );
    }

    // ---------------------------------------------------------
    // 9. GET TRANSACTIONS
    // ---------------------------------------------------------

    const now = new Date();

    const startDate = new Date(
      now.getFullYear(),
      now.getMonth() - 2,
      1
    )
      .toISOString()
      .split('T')[0];

    const endDate =
      now.toISOString().split('T')[0];

    let plaidTransactions: any[] = [];

    try {
      const transactionsResponse =
        await plaidClient.transactionsGet({
          access_token: accessToken,
          start_date: startDate,
          end_date: endDate,
        });

      plaidTransactions =
        transactionsResponse.data.transactions || [];

      console.log(
        `[plaid/exchange] Plaid returned ${plaidTransactions.length} transactions`
      );
    } catch (transactionError: any) {
      console.error(
        '[plaid/exchange] Transaction request failed:',
        transactionError?.response?.data ||
          transactionError
      );

      // The bank connection and accounts were successfully saved.
      return NextResponse.json({
        success: true,
        plaid_item_id: plaidItemDatabaseId,
        accounts: accountIdMap.size,
        count: 0,
        message:
          'Bank connected successfully. Plaid did not return transactions yet.',
      });
    }

    // ---------------------------------------------------------
    // 10. BUILD TRANSACTION RECORDS
    // ---------------------------------------------------------
    //
    // IMPORTANT:
    // account_id is NOT NULL in your transactions table.
    // Therefore, transactions without a matching local account
    // are skipped instead of causing the entire insert to fail.
    //
    // ---------------------------------------------------------

    const transactionRecords = plaidTransactions
      .map((tx) => {
        const localAccountId =
          accountIdMap.get(tx.account_id);

        if (!localAccountId) {
          console.warn(
            '[plaid/exchange] Skipping transaction with no local account:',
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
            userId,

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
          transaction
        ): transaction is NonNullable<
          typeof transaction
        > => transaction !== null
      );

    // ---------------------------------------------------------
    // 11. SAVE TRANSACTIONS
    // ---------------------------------------------------------

    if (transactionRecords.length > 0) {
      const {
        error: transactionError,
      } = await db
        .from('transactions')
        .upsert(
          transactionRecords,
          {
            onConflict:
              'plaid_transaction_id',
          }
        );

      if (transactionError) {
        console.error(
          '[plaid/exchange] Failed to save transactions:',
          transactionError
        );

        return NextResponse.json(
          {
            success: false,
            error:
              transactionError.message,
          },
          { status: 500 }
        );
      }
    }

    // ---------------------------------------------------------
    // 12. UPDATE PLAID ITEM SYNC TIME
    // ---------------------------------------------------------

    await db
      .from('plaid_items')
      .update({
        last_synced_at:
          new Date().toISOString(),
        status: 'active',
      })
      .eq(
        'id',
        plaidItemDatabaseId
      );

    // ---------------------------------------------------------
    // 13. SUCCESS
    // ---------------------------------------------------------

    console.log(
      '[plaid/exchange] SUCCESS:',
      {
        userId,
        plaidItemId,
        localPlaidItemId:
          plaidItemDatabaseId,
        accounts:
          accountIdMap.size,
        plaidTransactions:
          plaidTransactions.length,
        savedTransactions:
          transactionRecords.length,
      }
    );

    return NextResponse.json({
      success: true,

      plaid_item_id:
        plaidItemDatabaseId,

      accounts:
        accountIdMap.size,

      plaid_transactions:
        plaidTransactions.length,

      count:
        transactionRecords.length,

      message:
        'Bank connected and transactions synchronized successfully.',
    });
  } catch (error: any) {
    console.error(
      '[plaid/exchange] FAILED:',
      error?.response?.data ||
        error?.message ||
        error
    );

    const plaidError =
      error?.response?.data;

    return NextResponse.json(
      {
        success: false,
        error:
          plaidError?.error_message ||
          error?.message ||
          'Failed to connect bank account.',
      },
      { status: 500 }
    );
  }
}
