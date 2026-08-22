// app/api/plaid/exchange/route.ts
// Uses service role client for plaid_items, accounts, and transactions writes
// to bypass RLS — these are server-side operations that need elevated access.
// Auth check still happens first to confirm the user is logged in.

import { NextResponse } from 'next/server';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { createRouteHandlerClient } from '@/lib/supabase-server';
import { createClient } from '@supabase/supabase-js';

const configuration = new Configuration({
  basePath: PlaidEnvironments[(process.env.PLAID_ENV as keyof typeof PlaidEnvironments) || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(configuration);

function serviceRole() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

export async function POST(req: Request) {
  // Auth check — confirm user is logged in
  const authClient = createRouteHandlerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const db = serviceRole(); // all writes use service role to bypass RLS

  try {
    const { public_token, client_id, clientId } = await req.json();
    const resolvedClientId = clientId || client_id;

    if (!public_token) {
      return NextResponse.json({ error: 'Missing public_token' }, { status: 400 });
    }

    // 1. Exchange public token
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token });
    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;

    // 2. Upsert plaid_item
    const { data: plaidItem, error: itemError } = await db
      .from('plaid_items')
      .upsert({
        client_id: resolvedClientId,
        plaid_item_id: itemId,
        access_token_encrypted: Buffer.from(accessToken).toString('base64'),
        status: 'active',
        last_synced_at: new Date().toISOString(),
      }, { onConflict: 'plaid_item_id' })
      .select('id')
      .single();

    if (itemError) console.error('[exchange] plaid_item upsert failed:', itemError.message);
    const plaidItemId = plaidItem?.id;

    // 3. Get and upsert accounts
    const accountsResponse = await plaidClient.accountsGet({ access_token: accessToken });
    const accountIdMap = new Map<string, string>();

    for (const acct of accountsResponse.data.accounts) {
      const { data: accountRow, error: acctError } = await db
        .from('accounts')
        .upsert({
          plaid_item_id: plaidItemId,
          plaid_account_id: acct.account_id,
          name: acct.name,
          mask: acct.mask,
          type: acct.type,
          subtype: acct.subtype,
        }, { onConflict: 'plaid_account_id' })
        .select('id, plaid_account_id')
        .single();

      if (acctError) console.error('[exchange] account upsert failed:', acctError.message);
      else if (accountRow) accountIdMap.set(acct.account_id, accountRow.id);
    }

    // 4. Fetch and insert transactions
    const now = new Date();
    const startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const endDate = now.toISOString().split('T')[0];

    const { data: plaidTxData } = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
    });

    if (plaidTxData.transactions.length > 0) {
      const records = plaidTxData.transactions.map((tx) => ({
        plaid_transaction_id: tx.transaction_id,
        account_id: accountIdMap.get(tx.account_id) ?? null,
        client_id: resolvedClientId,
        posted_date: tx.date,
        amount: tx.amount,
        merchant_name: tx.merchant_name || tx.name,
        raw_plaid_category: tx.category ? tx.category.join(', ') : null,
        status: 'pending_review',
      }));

      const { error: txError } = await db
        .from('transactions')
        .upsert(records, { onConflict: 'plaid_transaction_id' });

      if (txError) {
        console.error('[exchange] transactions insert failed:', txError.message);
        return NextResponse.json({ error: txError.message }, { status: 500 });
      }
    }

    console.log(`[exchange] Synced ${plaidTxData.transactions.length} transactions for client ${resolvedClientId}`);
    return NextResponse.json({ success: true, count: plaidTxData.transactions.length });
  } catch (err: any) {
    console.error('[exchange] failed:', err.response?.data || err.message);
    return NextResponse.json({ error: 'Failed to exchange token' }, { status: 500 });
  }
}