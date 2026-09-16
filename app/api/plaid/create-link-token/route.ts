// app/api/plaid/create-link-token/route.ts

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
    // 1. AUTHENTICATE CURRENT BOOKKEEPER
    // ---------------------------------------------------------

    const authClient = await createRouteHandlerClient();

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      console.error(
        '[plaid/create-link-token] Authentication failed:',
        authError
      );

      return NextResponse.json(
        {
          success: false,
          error: 'Not authenticated.',
        },
        { status: 401 }
      );
    }

    // ---------------------------------------------------------
    // 2. READ CLIENT ID
    // ---------------------------------------------------------

    const body = await req.json().catch(() => ({}));

    const clientId =
      body?.client_id ||
      body?.clientId ||
      null;

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
    // 3. SERVICE-ROLE DATABASE CLIENT
    // ---------------------------------------------------------

    const db = createServiceRoleClient();

    // ---------------------------------------------------------
    // 4. FIND FIRMS THIS USER BELONGS TO
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
        '[plaid/create-link-token] Membership lookup failed:',
        membershipError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Unable to verify your accounting firm membership.',
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
    // 5. VERIFY THE SELECTED CLIENT
    // ---------------------------------------------------------

    const {
      data: selectedClient,
      error: clientError,
    } = await db
      .from('clients')
      .select(
        'id, firm_id, business_name, status'
      )
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (clientError) {
      console.error(
        '[plaid/create-link-token] Client lookup failed:',
        clientError
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'Unable to verify the selected LedgerAI client.',
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

    // ---------------------------------------------------------
    // 6. CREATE PLAID LINK TOKEN
    // ---------------------------------------------------------

    /*
     * This value must remain stable for this LedgerAI client.
     *
     * We intentionally use the LedgerAI clients.id UUID rather
     * than the authenticated bookkeeper's user ID.
     *
     * That means:
     *
     * ABC Plumbing       -> one stable Plaid user identity
     * Smith Consulting   -> another stable Plaid user identity
     * Green Bakery       -> another stable Plaid user identity
     *
     * Multiple bookkeepers can therefore work with the same
     * client without changing that client's Plaid identity.
     */

    const plaidClientUserId =
      `ledgerai-client-${selectedClient.id}`;

    const response =
      await plaidClient.linkTokenCreate({
        user: {
          client_user_id: plaidClientUserId,
        },

        client_name: 'LedgerAI App',

        products: [
          'transactions',
        ] as any,

        country_codes: [
          'US',
        ] as any,

        language: 'en',
      });

    console.log(
      '[plaid/create-link-token] Link token created',
      {
        authenticatedUser: user.id,
        clientId: selectedClient.id,
        businessName:
          selectedClient.business_name,
        plaidClientUserId,
      }
    );

    // ---------------------------------------------------------
    // 7. RETURN LINK TOKEN
    // ---------------------------------------------------------

    return NextResponse.json(
      {
        success: true,
        link_token:
          response.data.link_token,
        client_id:
          selectedClient.id,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error(
      '[plaid/create-link-token] FAILED:',
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
          'Failed to create Plaid Link token.',
      },
      { status: 500 }
    );
  }
}