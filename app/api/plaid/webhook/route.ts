// app/api/plaid/webhook/route.ts

import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} from 'plaid';
import { syncPlaidItem } from '@/lib/plaid-sync';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

async function verifyPlaidWebhook(
  rawBody: string,
  verificationToken: string
) {
  /*
   * jose is loaded dynamically here.
   *
   * This allows the vscode.dev browser workspace to remain usable
   * even when its TypeScript language service has not refreshed
   * newly added dependencies yet.
   *
   * Vercel installs package.json dependencies during the build.
   */
  const joseModuleName = 'jose';

  const {
    decodeProtectedHeader,
    importJWK,
    jwtVerify,
  } = await import(joseModuleName);

  // ---------------------------------------------------------
  // 1. READ JWT HEADER WITHOUT TRUSTING IT YET
  // ---------------------------------------------------------

  const protectedHeader =
    decodeProtectedHeader(verificationToken);

  if (protectedHeader.alg !== 'ES256') {
    throw new Error(
      'Unexpected Plaid webhook signing algorithm.'
    );
  }

  const keyId = protectedHeader.kid;

  if (!keyId || typeof keyId !== 'string') {
    throw new Error(
      'Plaid webhook verification key ID is missing.'
    );
  }

  // ---------------------------------------------------------
  // 2. GET PLAID'S PUBLIC VERIFICATION KEY
  // ---------------------------------------------------------

  const keyResponse =
    await plaidClient.webhookVerificationKeyGet({
      key_id: keyId,
    });

  const jwk = keyResponse.data.key;

  if (!jwk) {
    throw new Error(
      'Plaid webhook verification key was not returned.'
    );
  }

  if (
    jwk.alg !== 'ES256' ||
    jwk.kid !== keyId
  ) {
    throw new Error(
      'Plaid webhook verification key is invalid.'
    );
  }

  const publicKey = await importJWK(
    jwk as any,
    'ES256'
  );

  // ---------------------------------------------------------
  // 3. VERIFY JWT SIGNATURE AND AGE
  // ---------------------------------------------------------

  const { payload } = await jwtVerify(
    verificationToken,
    publicKey,
    {
      algorithms: ['ES256'],
      maxTokenAge: '5 min',
    }
  );

  // ---------------------------------------------------------
  // 4. VERIFY EXACT RAW REQUEST BODY
  // ---------------------------------------------------------

  const claimedBodyHash =
    payload.request_body_sha256;

  if (
    !claimedBodyHash ||
    typeof claimedBodyHash !== 'string'
  ) {
    throw new Error(
      'Plaid webhook body hash is missing.'
    );
  }

  const normalizedClaimedHash =
    claimedBodyHash.toLowerCase();

  if (
    !/^[a-f0-9]{64}$/.test(
      normalizedClaimedHash
    )
  ) {
    throw new Error(
      'Plaid webhook body hash is invalid.'
    );
  }

  const actualBodyHash =
    createHash('sha256')
      .update(rawBody, 'utf8')
      .digest('hex');

  if (
    actualBodyHash !==
    normalizedClaimedHash
  ) {
    throw new Error(
      'Plaid webhook body verification failed.'
    );
  }
}

export async function POST(req: Request) {
  try {
    // ---------------------------------------------------------
    // 1. PRESERVE ORIGINAL RAW BODY
    // ---------------------------------------------------------

    const rawBody = await req.text();

    const verificationToken =
      req.headers.get('plaid-verification');

    if (!verificationToken) {
      console.warn(
        '[plaid/webhook] Missing Plaid-Verification header.'
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Webhook verification header is missing.',
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 2. CRYPTOGRAPHICALLY VERIFY PLAID
    // ---------------------------------------------------------

    try {
      await verifyPlaidWebhook(
        rawBody,
        verificationToken
      );
    } catch (verificationError: any) {
      console.error(
        '[plaid/webhook] Verification failed:',
        verificationError?.message ||
          verificationError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Webhook verification failed.',
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 3. PARSE BODY ONLY AFTER VERIFICATION
    // ---------------------------------------------------------

    let body: any;

    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid webhook JSON.',
        },
        { status: 400 }
      );
    }

    const webhookType =
      body?.webhook_type;

    const webhookCode =
      body?.webhook_code;

    const plaidItemId =
      body?.item_id;

    // ---------------------------------------------------------
    // 4. ACKNOWLEDGE EVENTS LEDGERAI DOES NOT PROCESS
    // ---------------------------------------------------------

    if (
      webhookType !== 'TRANSACTIONS' ||
      webhookCode !== 'SYNC_UPDATES_AVAILABLE'
    ) {
      console.log(
        '[plaid/webhook] Verified webhook acknowledged without processing:',
        {
          webhookType,
          webhookCode,
          plaidItemId:
            plaidItemId || null,
        }
      );

      return NextResponse.json(
        {
          success: true,
          processed: false,
        },
        { status: 200 }
      );
    }

    if (
      !plaidItemId ||
      typeof plaidItemId !== 'string'
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Plaid Item ID is missing from the webhook.',
        },
        { status: 400 }
      );
    }

    // ---------------------------------------------------------
    // 5. FIND THE LEDGERAI PLAID ITEM
    //
    // The request has already been cryptographically verified.
    // Plaid's item_id identifies the stored LedgerAI Item.
    // ---------------------------------------------------------

    const db = createServiceRoleClient();

    const {
      data: item,
      error: itemError,
    } = await db
      .from('plaid_items')
      .select(`
        id,
        client_id,
        plaid_item_id,
        access_token_encrypted,
        status,
        cursor,
        last_synced_at
      `)
      .eq(
        'plaid_item_id',
        plaidItemId
      )
      .eq('status', 'active')
      .maybeSingle();

    if (itemError) {
      console.error(
        '[plaid/webhook] Plaid Item lookup failed:',
        itemError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Unable to locate the Plaid Item.',
        },
        { status: 500 }
      );
    }

    if (!item) {
      console.warn(
        '[plaid/webhook] Verified webhook references an unknown or inactive Item:',
        {
          plaidItemId,
        }
      );

      /*
       * This is a legitimate Plaid request, but LedgerAI has
       * nothing active to synchronize. Acknowledge it rather
       * than causing repeated retries.
       */
      return NextResponse.json(
        {
          success: true,
          processed: false,
        },
        { status: 200 }
      );
    }

    // ---------------------------------------------------------
    // 6. USE THE SAME ENGINE AS MANUAL REFRESH
    // ---------------------------------------------------------

    const result = await syncPlaidItem({
      db,
      item,
    });

    if (!result.success) {
      console.error(
        '[plaid/webhook] Item synchronization failed:',
        {
          plaidItemId,
          clientId:
            item.client_id,
          error:
            result.error,
        }
      );

      return NextResponse.json(
        {
          success: false,
          processed: false,
          error:
            result.error ||
            'Plaid Item synchronization failed.',
        },
        { status: 500 }
      );
    }

    console.log(
      '[plaid/webhook] SYNC_UPDATES_AVAILABLE processed:',
      {
        plaidItemId,
        clientId:
          item.client_id,
        added:
          result.added,
        modified:
          result.modified,
        removed:
          result.removed,
        skipped:
          result.skipped,
      }
    );

    return NextResponse.json(
      {
        success: true,
        processed: true,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error(
      '[plaid/webhook] FAILED:',
      error?.response?.data ||
        error?.message ||
        error
    );

    return NextResponse.json(
      {
        success: false,
        error:
          'Webhook processing failed.',
      },
      { status: 500 }
    );
  }
}