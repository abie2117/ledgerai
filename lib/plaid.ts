// lib/plaid.ts
// Server-side only. Never import this into a client component.

import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";
import { createClient } from "@supabase/supabase-js";

const config = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV as keyof typeof PlaidEnvironments],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID!,
      "PLAID-SECRET": process.env.PLAID_SECRET!,
    },
  },
});

export const plaidClient = new PlaidApi(config);

function supabaseAdmin() {
  // Service-role client for server-side writes that bypass RLS
  // (RLS is still the source of truth for all client-facing queries).
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

/**
 * Step 1: create a Link token for a specific client so the bookkeeper
 * can open Plaid Link in the frontend.
 */
export async function createLinkToken(clientId: string, userId: string) {
  const response = await plaidClient.linkTokenCreate({
    user: { client_user_id: userId },
    client_name: "LedgerAI",
    products: [Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
    webhook: process.env.PLAID_WEBHOOK_URL,
    // client_id is threaded through Link's metadata so our webhook/exchange
    // handlers know which LedgerAI client this connection belongs to.
    redirect_uri: undefined,
  });
  return response.data.link_token;
}

/**
 * Step 2: exchange the public_token Link returns for a durable
 * access_token + item_id, then store it encrypted against the client.
 */
export async function exchangePublicToken(publicToken: string, clientId: string) {
  const exchange = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken,
  });
  const { access_token, item_id } = exchange.data;

  const institution = await getInstitutionName(access_token);

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc("insert_plaid_item_encrypted", {
    p_client_id: clientId,
    p_plaid_item_id: item_id,
    p_access_token: access_token,
    p_institution_name: institution,
  });
  // `insert_plaid_item_encrypted` is a Postgres function that runs
  // pgp_sym_encrypt(access_token, key) server-side — see schema/002_encryption.sql
  if (error) throw error;

  await pullInitialTransactions(item_id, access_token, clientId);
  return data;
}

async function getInstitutionName(accessToken: string): Promise<string | undefined> {
  const item = await plaidClient.itemGet({ access_token: accessToken });
  const institutionId = item.data.item.institution_id;
  if (!institutionId) return undefined;
  const inst = await plaidClient.institutionsGetById({
    institution_id: institutionId,
    country_codes: [CountryCode.Us],
  });
  return inst.data.institution.name;
}

/**
 * Initial full pull using /transactions/sync, paging until has_more is false.
 */
async function pullInitialTransactions(itemId: string, accessToken: string, clientId: string) {
  let cursor: string | undefined = undefined;
  let hasMore = true;
  const supabase = supabaseAdmin();

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor,
    });
    const { added, modified, removed, next_cursor, has_more } = resp.data;

    if (added.length) await upsertTransactions(supabase, added, clientId);
    if (modified.length) await upsertTransactions(supabase, modified, clientId);
    if (removed.length) await markTransactionsRemoved(supabase, removed);

    cursor = next_cursor;
    hasMore = has_more;
  }

  await supabase
    .from("plaid_items")
    .update({ cursor, last_synced_at: new Date().toISOString() })
    .eq("plaid_item_id", itemId);
}

/**
 * Called from the webhook handler on SYNC_UPDATES_AVAILABLE — pulls only
 * the delta since the stored cursor.
 */
export async function syncTransactionsDelta(itemId: string) {
  const supabase = supabaseAdmin();
  const { data: item, error } = await supabase
    .from("plaid_items")
    .select("id, client_id, cursor, access_token_encrypted")
    .eq("plaid_item_id", itemId)
    .single();
  if (error || !item) throw error ?? new Error("plaid_item not found");

  const accessToken = await decryptAccessToken(item.access_token_encrypted);
  let cursor = item.cursor ?? undefined;
  let hasMore = true;

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({ access_token: accessToken, cursor });
    const { added, modified, removed, next_cursor, has_more } = resp.data;

    if (added.length) await upsertTransactions(supabase, added, item.client_id);
    if (modified.length) await upsertTransactions(supabase, modified, item.client_id);
    if (removed.length) await markTransactionsRemoved(supabase, removed);

    cursor = next_cursor;
    hasMore = has_more;
  }

  await supabase
    .from("plaid_items")
    .update({ cursor, last_synced_at: new Date().toISOString() })
    .eq("plaid_item_id", itemId);

  // Kick off categorization for whatever just landed as pending_review.
  await import("./categorization").then((m) => m.categorizePendingTransactions(item.client_id));
}

async function upsertTransactions(supabase: ReturnType<typeof supabaseAdmin>, txns: any[], clientId: string) {
  const rows = txns.map((t) => ({
    plaid_transaction_id: t.transaction_id,
    posted_date: t.date,
    amount: t.amount,
    merchant_name: t.merchant_name ?? t.name,
    raw_plaid_category: t.personal_finance_category?.primary ?? null,
    client_id: clientId,
    status: "pending_review",
  }));
  const { error } = await supabase
    .from("transactions")
    .upsert(rows, { onConflict: "plaid_transaction_id" });
  if (error) throw error;
}

async function markTransactionsRemoved(supabase: ReturnType<typeof supabaseAdmin>, removed: any[]) {
  const ids = removed.map((r) => r.transaction_id);
  const { error } = await supabase
    .from("transactions")
    .delete()
    .in("plaid_transaction_id", ids);
  if (error) throw error;
}

async function decryptAccessToken(encrypted: string): Promise<string> {
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc("decrypt_plaid_access_token", {
    p_encrypted: encrypted,
  });
  if (error) throw error;
  return data as string;
}
