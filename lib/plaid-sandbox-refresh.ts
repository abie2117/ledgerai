import 'server-only';
import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid';
import { readPlaidAccessToken } from './plaid-token-storage';

// Fail closed: enable one isolated, unactivated connection explicitly.
export function canGenerateSandboxUpdate(clientId: string, itemId: string, status: string, financialStatus: string) {
  return process.env.PLAID_ENV === 'sandbox'
    && !!process.env.PLAID_SANDBOX_TEST_CLIENT_ID
    && !!process.env.PLAID_SANDBOX_TEST_CONNECTION_ID
    && clientId === process.env.PLAID_SANDBOX_TEST_CLIENT_ID
    && itemId === process.env.PLAID_SANDBOX_TEST_CONNECTION_ID
    && status === 'active'
    && financialStatus === 'pending_review';
}

export async function generateSandboxUpdate(item: {
  id: string; client_id: string; status: string; financial_source_status: string;
  plaid_item_id: string; token_key_version: number; access_token_encrypted: unknown;
}) {
  if (!canGenerateSandboxUpdate(item.client_id, item.id, item.status, item.financial_source_status)) {
    throw new Error('Sandbox test updates are disabled for this connection.');
  }
  const accessToken = await readPlaidAccessToken(item);
  const client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments.sandbox,
    baseOptions: { headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID!,
      'PLAID-SECRET': process.env.PLAID_SECRET!,
    } },
  }));
  await client.transactionsRefresh({ access_token: accessToken });
}
