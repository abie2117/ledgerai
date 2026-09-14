// app/api/plaid/exchange/route.ts

import { NextResponse } from 'next/server';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const plaidEnvironment =
  (process.env.PLAID_ENV as keyof typeof PlaidEnvironments) || 'sandbox';

const configuration = new Configuration({
  basePath: PlaidEnvironments[plaidEnvironment],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
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
     * 1. AUTHENTICATE THE CURRENT LEDGERAI USER
     * ---------------------------------------------------------
     */

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
     * 2. READ PLAID PUBLIC TOKEN
     * ---------------------------------------------------------
     */

    const body = await req.json();

    const publicToken = body?.public_token;

    if (!publicToken) {
      return NextResponse.json(
        {
          error: 'Missing public_token',
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
     * 4. SERVER-SIDE SUPABASE CLIENT
     * ---------------------------------------------------------
     */

    const db = serviceRoleClient();

    /*
     * ---------------------------------------------------------
     * 5. GET PLAID ACCOUNTS FIRST
     * ---------------------------------------------------------
     *
     * We must create the accounts before inserting
     * transactions. This prevents account_id from becoming null.
     */

    const accountsResponse =
      await plaidClient.accountsGet({
        access_token: accessToken,
      });

    const plaidAccounts =
      accountsResponse.data.accounts;

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
     * 6. CREATE / UPDATE PLAID ITEM
     * ---------------------------------------------------------
     *
     * IMPORTANT:
     * We associate the Plaid item with the authenticated
     * LedgerAI user.
     */

    const { data: plaidItem, error: plaidItemError } =
      await db
        .from('plaid_items')
        .upsert(
          {
            client_id: userId,
            plaid_item_id: plaidItemId,
            access_token_encrypted: Buffer.from(
              accessToken
            ).toString('base64'),
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

    if (plaidItemError || !plaidItem) {
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
      '[plaid/exchange] Saved Plaid item:',
      plaidItemDatabaseId
    );

    /*
     * ---------------------------------------------------------
     * 7. CREATE / UPDATE ACCOUNTS
     * ---------------------------------------------------------
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
              'Plaid Account',
            mask:
              account.mask || null,
            type:
              account.type || null,
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

      if (accountError || !accountRow) {
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
        '→',
        accountRow.id
      );
    }

    /*
     * ---------------------------------------------------------
     * 8. MAKE SURE WE ACTUALLY CREATED ACCOUNTS
     * ---------------------------------------------------------
     */

    if (accountIdMap.size === 0) {
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
     * 9. GET TRANSACTIONS FROM PLAID
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
        transactionsResponse.data
          .transactions || [];
    } catch (transactionError: any) {
      console.error(
        '[plaid/exchange] Transactions request failed:',
        transactionError?.response?.data ||
          transactionError
      );

      /*
       * The bank connection itself is still valid.
       * Return success for the connection instead of
       * pretending the entire Plaid connection failed.
       */

      return NextResponse.json({
        success: true,
        count: 0,
        message:
          'Bank connected successfully. Transactions are not available yet.',
      });
    }

    /*
     * ---------------------------------------------------------
     * 10. PREPARE TRANSACTIONS
     * ---------------------------------------------------------
     *
     * IMPORTANT:
     * Never insert a transaction when we cannot resolve
     * its account_id.
     */

    const transactionRecords =
      plaidTransactions
        .map((tx) => {
          const databaseAccountId =
            accountIdMap.get(
              tx.account_id
            );

          if (!databaseAccountId) {
            console.warn(
              '[plaid/exchange] Skipping transaction because account was not found:',
              tx.transaction_id,
              tx.account_id
            );

            return null;
          }

          return {
            plaid_transaction_id:
              tx.transaction_id,

            account_id:
              databaseAccountId,

            client_id:
              userId,

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
          > => record !== null
        );

    /*
     * ---------------------------------------------------------
     * 11. INSERT TRANSACTIONS
     * ---------------------------------------------------------
     */

    if (
      transactionRecords.length > 0
    ) {
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
     * 12. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      '[plaid/exchange] SUCCESS',
      {
        userId,
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
          error?.response?.data?.error_message ||
          error?.message ||
          'Failed to connect bank account.',
      },
      {
        status: 500,
      }
    );
  }
}
