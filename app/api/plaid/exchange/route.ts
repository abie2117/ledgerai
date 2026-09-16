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
     * The access-token storage should be upgraded separately.
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
    // 10. GET TRANSACTIONS
    // ---------------------------------------------------------

    const now = new Date();

    const startDate =
      new Date(
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
        transactionsResponse.data.transactions ||
        [];
    } catch (transactionError: any) {
      console.error(
        '[plaid/exchange] Transaction request failed:',
        transactionError?.response?.data ||
          transactionError
      );

      return NextResponse.json({
        success: true,
        plaid_item_id:
          plaidItemDatabaseId,
        client_id: clientId,
        accounts:
          accountIdMap.size,
        count: 0,
        message:
          'Bank connected successfully. Transactions are not available yet.',
      });
    }

    // ---------------------------------------------------------
    // 11. BUILD TRANSACTION RECORDS
    // ---------------------------------------------------------

    const transactionRecords =
      plaidTransactions
        .map((tx) => {
          const localAccountId =
            accountIdMap.get(
              tx.account_id
            );

          if (!localAccountId) {
            console.warn(
              '[plaid/exchange] Skipping transaction with unknown account:',
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
    // 12. SAVE TRANSACTIONS
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
          '[plaid/exchange] Transaction save failed:',
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
    // 13. UPDATE LAST SYNC TIME
    // ---------------------------------------------------------

    await db
      .from('plaid_items')
      .update({
        status: 'active',
        last_synced_at:
          new Date().toISOString(),
      })
      .eq(
        'id',
        plaidItemDatabaseId
      );

    // ---------------------------------------------------------
    // 14. SUCCESS
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

      client_id:
        clientId,

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