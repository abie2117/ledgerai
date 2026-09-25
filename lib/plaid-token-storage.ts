import 'server-only';
import { createClient } from '@supabase/supabase-js';

type PlaidTokenStorageInput = {
  plaid_item_id: string;
  token_key_version: number;
  access_token_encrypted: unknown;
};

function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  );
}

function toByteaRpcInput(storedToken: unknown) {
  if (
    storedToken &&
    typeof storedToken === 'object' &&
    'data' in storedToken &&
    Array.isArray(
      (storedToken as { data?: unknown }).data,
    )
  ) {
    return `\\x${Buffer.from(
      (storedToken as { data: number[] }).data,
    ).toString('hex')}`;
  }

  return storedToken;
}

async function readEncryptedToken(storedToken: unknown) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.rpc(
    'decrypt_plaid_access_token',
    {
      p_encrypted: toByteaRpcInput(storedToken),
    },
  );

  if (error || typeof data !== 'string' || !data) {
    throw new Error('Unable to decrypt stored Plaid access token.');
  }

  return data;
}

export async function readPlaidAccessToken({
  token_key_version: tokenKeyVersion,
  access_token_encrypted: storedToken,
}: PlaidTokenStorageInput) {
  if (tokenKeyVersion === 2) {
    return readEncryptedToken(storedToken);
  }

  throw new Error(
    `Unsupported Plaid token storage version: ${tokenKeyVersion}`,
  );
}