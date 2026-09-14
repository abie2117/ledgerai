// app/api/plaid/exchange/route.ts

import { NextResponse } from 'next/server';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const TEST_CLIENT_ID =
  '00000000-0000-0000-0000-000000000002';

const plaidEnvironment =
  (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) ||
  'sandbox';

const configuration = new Configuration({
  basePath: PlaidEnvironments[plaidEnvironment],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID':
        process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET':
        process.env.PLAID_SECRET!,
    },
  },
});

const plaidClient = new PlaidApi(configuration);

function serviceRoleClient() {
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
     * 1. AUTHENTICATE USER
     * ---------------------------------------------------------
     */

    const authClient =
      await createRouteHandlerClient();

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
          error: 'Not authenticated',
        },
        {
          status: 401,
        }
      );
    }

    const userId = user.id;

    console.log(
      '[plaid/exchange] Authenticated user:',
      userId
    );

    /*
     * ---------------------------------------------------------
     * 2. READ PUBLIC TOKEN
     * ---------------------------------------------------------
     */

    const body = await req.json();

    const publicToken =
      body?.public_token;

    if (!publicToken) {
      return NextResponse.json(
        {
          error:
            'Missing public_token',
        },
        {
          status: 400,
        }
      );
    }

    /*
     * ---------------------------------------------------------
     * 3. EXCHANGE PLAID PUBLIC TOKEN
     * ---------------------------------------------------------
     */

    console.log(
      '[plaid/exchange] Exchanging Plaid public token...'
    );

    const exchangeResponse =
      await plaidClient.itemPublicTokenExchange({
        public_token: publicToken,
      });

    const accessToken =
      exchangeResponse.data.access_token;

    const plaidItemId =
      exchangeResponse.data.item_id;

    console.log(
      '[plaid/exchange] Plaid item:',
      plaidItemId
    );

    /*
     * ---------------------------------------------------------
     * 4. SERVER SUPABASE CLIENT
     * ---------------------------------------------------------
     */

    const db =
      serviceRoleClient();

    /*
     * ---------------------------------------------------------
     * 5. GET PLAID ACCOUNTS
     * ---------------------------------------------------------
     */

    console.log(
      '[plaid/exchange] Fetching Plaid accounts...'
    );

    const accountsResponse =
      await plaidClient.accountsGet({
        access_token: accessToken,
      });

    const plaidAccounts =
      accountsResponse.data.accounts || [];

    console.log(
      `[plaid/exchange] Plaid returned ${plaidAccounts.length} accounts`
    );

    if (plaidAccounts.length === 0) {
      return NextResponse.json(
        {
          error:
            'Plaid connected successfully, but no accounts were returned.',
        },
        {
          status: 400,
        }
      );
    }

    /*
     * ---------------------------------------------------------
     * 6. SAVE PLAID ITEM
     * ---------------------------------------------------------
     *
     * IMPORTANT:
     *
     * client_id MUST be a real ID from the clients table.
     *
     * We are using the existing Test Client Business because
     * this LedgerAI installation is being tested without a
     * real bank account.
     *
     * user_id is kept separately for the authenticated user.
     */

    const {
      data: plaidItem,
      error: plaidItemError,
    } = await db
      .from('plaid_items')
      .upsert(
        {
          client_id:
            TEST_CLIENT_ID,

          plaid_item_id:
            plaidItemId,

          access_token_encrypted:
            Buffer.from(
              accessToken
            ).toString('base64'),

          status: 'active',

          last_synced_at:
            new Date().toISOString(),
        },
        {
          onConflict:
            'plaid_item_id',
        }
      )
      .select('id')
      .single();

    if (
      plaidItemError ||
      !plaidItem
    ) {
      console.error(
        '[plaid/exchange] Failed to save Plaid connection:',
        plaidItemError
      );

      return NextResponse.json(
        {
          error:
            plaidItemError?.message ||
            'Failed to save Plaid connection.',
        },
        {
          status: 500,
        }
      );
    }

    const plaidItemDatabaseId =
      plaidItem.id;

    console.log(
      '[plaid/exchange] Plaid item saved:',
      plaidItemDatabaseId
    );

    /*
     * ---------------------------------------------------------
     * 7. SAVE PLAID ACCOUNTS
     * ---------------------------------------------------------
     */

    const accountIdMap =
      new Map<string, string>();

    for (
      const account of plaidAccounts
    ) {
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
              account.mask ||
              null,

            type:
              account.type ||
              null,

            subtype:
              account.subtype ||
              null,
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

      if (
        accountError ||
        !accountRow
      ) {
        console.error(
          '[plaid/exchange] Failed to save account:',
          accountError
        );

        continue;
      }

      accountIdMap.set(
        account.account_id,
        accountRow.id
      );

      console.log(
        '[plaid/exchange] Account mapped:',
        account.account_id,
        '=>',
        accountRow.id
      );
    }

    if (
      accountIdMap.size === 0
    ) {
      return NextResponse.json(
        {
          error:
            'Plaid connected, but LedgerAI could not create any accounts.',
        },
        {
          status: 500,
        }
      );
    }

    /*
     * ---------------------------------------------------------
     * 8. FETCH TRANSACTIONS
     * ---------------------------------------------------------
     */

    const now =
      new Date();

    const startDate =
      new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        1
      )
        .toISOString()
        .split('T')[0];

    const endDate =
      now
        .toISOString()
        .split('T')[0];

    let plaidTransactions: any[] =
      [];

    try {
      console.log(
        '[plaid/exchange] Fetching Plaid transactions...',
        {
          startDate,
          endDate,
        }
      );

      const transactionsResponse =
        await plaidClient.transactionsGet({
          access_token:
            accessToken,

          start_date:
            startDate,

          end_date:
            endDate,
        });

      plaidTransactions =
        transactionsResponse.data
          .transactions || [];

      console.log(
        `[plaid/exchange] Plaid returned ${plaidTransactions.length} transactions`
      );
    } catch (
      transactionError: any
    ) {
      console.error(
        '[plaid/exchange] Transactions request failed:',
        transactionError?.response
          ?.data ||
          transactionError
      );

      /*
       * The bank itself is connected.
       * Plaid Sandbox may not immediately return
       * transactions in every test scenario.
       */

      return NextResponse.json({
        success: true,

        plaid_item_id:
          plaidItemDatabaseId,

        accounts:
          accountIdMap.size,

        count: 0,

        message:
          'Bank connected successfully. Transactions are not available yet.',
      });
    }

    /*
     * ---------------------------------------------------------
     * 9. PREPARE TRANSACTIONS
     * ---------------------------------------------------------
     */

    const transactionRecords =
      plaidTransactions
        .map((tx) => {
          const databaseAccountId =
            accountIdMap.get(
              tx.account_id
            );

          /*
           * Never insert a transaction without
           * a valid account_id.
           */

          if (
            !databaseAccountId
          ) {
            console.warn(
              '[plaid/exchange] Skipping transaction because account was not mapped:',
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
            plaid_transaction_id:
              tx.transaction_id,

            account_id:
              databaseAccountId,

            /*
             * client_id points to the actual
             * LedgerAI client record.
             */

            client_id:
              TEST_CLIENT_ID,

            /*
             * user_id points to the
             * authenticated Supabase user.
             *
             * Your dashboard uses this field
             * to load transactions.
             */

            user_id:
              userId,

            posted_date:
              tx.date,

            /*
             * Plaid convention:
             * positive = money leaving account
             * negative = money entering account
             */

            amount:
              tx.amount,

            merchant_name:
              tx.merchant_name ||
              tx.name ||
              'Unknown Merchant',

            raw_plaid_category:
              Array.isArray(
                tx.category
              )
                ? tx.category.join(
                    ', '
                  )
                : null,

            category:
              'Uncategorized',

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

    /*
     * ---------------------------------------------------------
     * 10. SAVE TRANSACTIONS
     * ---------------------------------------------------------
     */

    if (
      transactionRecords.length > 0
    ) {
      console.log(
        `[plaid/exchange] Saving ${transactionRecords.length} transactions...`
      );

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

      if (
        transactionError
      ) {
        console.error(
          '[plaid/exchange] Transaction insert failed:',
          transactionError
        );

        return NextResponse.json(
          {
            error:
              transactionError.message,
          },
          {
            status: 500,
          }
        );
      }
    }

    /*
     * ---------------------------------------------------------
     * 11. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      '[plaid/exchange] SUCCESS',
      {
        userId,

        clientId:
          TEST_CLIENT_ID,

        plaidItemId,

        accounts:
          accountIdMap.size,

        transactions:
          transactionRecords.length,
      }
    );

    return NextResponse.json({
      success: true,

      plaid_item_id:
        plaidItemDatabaseId,

      client_id:
        TEST_CLIENT_ID,

      accounts:
        accountIdMap.size,

      count:
        transactionRecords.length,
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
        error:
          error?.response?.data
            ?.error_message ||
          error?.message ||
          'Failed to connect bank account.',
      },
      {
        status: 500,
      }
    );
  }
}
