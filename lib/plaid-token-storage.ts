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

function normalizeStoredByteaText(storedToken: unknown) {
  if (typeof storedToken === 'string') {
    return storedToken;
  }

  if (
    storedToken &&
    typeof storedToken === 'object' &&
    'data' in storedToken &&
    Array.isArray(
      (storedToken as { data?: unknown }).data,
    )
  ) {
    return Buffer.from(
      (storedToken as { data: number[] }).data,
    ).toString('utf8');
  }

  throw new Error('Unsupported access-token storage format.');
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

function readLegacyBase64Token(
  plaidItemId: string,
  storedToken: unknown,
) {
  if (plaidItemId.startsWith('item_test_')) {
    throw new Error(
      'Legacy token storage is not supported for test Plaid Items.',
    );
  }

  let encodedToken = normalizeStoredByteaText(storedToken);

  if (encodedToken.startsWith('\\x')) {
    encodedToken = Buffer.from(
      encodedToken.slice(2),
      'hex',
    ).toString('utf8');
  }

  const accessToken = Buffer.from(
    encodedToken,
    'base64',
  ).toString('utf8');

  if (!accessToken) {
    throw new Error(
      'Stored Plaid access token could not be decoded.',
    );
  }

  return accessToken;
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
  plaid_item_id: plaidItemId,
  token_key_version: tokenKeyVersion,
  access_token_encrypted: storedToken,
}: PlaidTokenStorageInput) {
  if (tokenKeyVersion === 1) {
    return readLegacyBase64Token(plaidItemId, storedToken);
  }

  if (tokenKeyVersion === 2) {
    return readEncryptedToken(storedToken);
  }

  throw new Error(
    `Unsupported Plaid token storage version: ${tokenKeyVersion}`,
  );
}