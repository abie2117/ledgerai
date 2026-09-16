import { NextResponse } from 'next/server';
import { createRouteHandlerClient } from '../../../lib/supabase-server';
import { createClient } from '@supabase/supabase-js';
import { categorizeWithLocalRules } from '../../../lib/categorization';

export const dynamic = 'force-dynamic';

function serviceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
      },
    },
  );
}

export async function POST(req: Request) {
  try {
    /*
     * ---------------------------------------------------------
     * 1. AUTHENTICATE CURRENT USER
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
        '[categorize-local] Authentication failed:',
        authError,
      );

      return NextResponse.json(
        {
          error: 'Not authenticated',
        },
        {
          status: 401,
        },
      );
    }

    /*
     * ---------------------------------------------------------
     * 2. READ REQUEST
     * ---------------------------------------------------------
     */

    let body: {
      clientId?: string;
    } = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const clientId =
      typeof body.clientId === 'string'
        ? body.clientId.trim()
        : '';

    /*
     * A LedgerAI user is a firm user/bookkeeper.
     * The authenticated user ID is NOT the client ID.
     *
     * Never silently fall back to user.id.
     */

    if (!clientId) {
      return NextResponse.json(
        {
          error: 'clientId is required',
        },
        {
          status: 400,
        },
      );
    }

    /*
     * ---------------------------------------------------------
     * 3. VERIFY USER BELONGS TO A FIRM
     * ---------------------------------------------------------
     */

    const db = serviceRoleClient();

    const {
      data: firmMemberships,
      error: membershipError,
    } = await db
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error(
        '[categorize-local] Firm membership lookup failed:',
        membershipError,
      );

      return NextResponse.json(
        {
          error: 'Unable to verify firm membership',
        },
        {
          status: 500,
        },
      );
    }

    const firmIds = Array.from(
      new Set(
        (firmMemberships || [])
          .map((membership: any) => membership.firm_id)
          .filter(Boolean),
      ),
    );

    if (!firmIds.length) {
      console.warn(
        '[categorize-local] User has no firm membership:',
        user.id,
      );

      return NextResponse.json(
        {
          error: 'No firm membership found',
        },
        {
          status: 403,
        },
      );
    }

    /*
     * ---------------------------------------------------------
     * 4. VERIFY CLIENT BELONGS TO USER'S FIRM
     * ---------------------------------------------------------
     */

    const {
      data: client,
      error: clientError,
    } = await db
      .from('clients')
      .select('id, firm_id, name, status')
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (clientError) {
      console.error(
        '[categorize-local] Client verification failed:',
        clientError,
      );

      return NextResponse.json(
        {
          error: 'Unable to verify client',
        },
        {
          status: 500,
        },
      );
    }

    if (!client) {
      console.warn(
        '[categorize-local] Client is not accessible to user:',
        {
          userId: user.id,
          clientId,
        },
      );

      return NextResponse.json(
        {
          error: 'Client not found or access denied',
        },
        {
          status: 403,
        },
      );
    }

    /*
     * Do not categorize transactions for an inactive client.
     *
     * This accepts either a boolean is_active column elsewhere
     * in the app or the status-style model used by this query.
     * Here we only reject an explicitly inactive status.
     */

    if (
      typeof client.status === 'string' &&
      client.status.toLowerCase() === 'inactive'
    ) {
      return NextResponse.json(
        {
          error: 'Client is inactive',
        },
        {
          status: 400,
        },
      );
    }

    /*
     * ---------------------------------------------------------
     * 5. RUN THE SINGLE LOCAL CATEGORIZATION ENGINE
     * ---------------------------------------------------------
     *
     * The actual categorization logic now lives in:
     *
     * lib/categorization.ts
     *
     * That function:
     * - uses client-specific learned mapping rules first
     * - resolves canonical category IDs
     * - prioritizes client categories over global duplicates
     * - synchronizes ai_category_id + category
     * - leaves transactions untouched when no safe match exists
     * - does NOT call Claude
     */

    console.log(
      '[categorize-local] Starting categorization:',
      {
        userId: user.id,
        clientId,
        clientName: client.name,
      },
    );

    const result =
      await categorizeWithLocalRules(clientId);

    /*
     * ---------------------------------------------------------
     * 6. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      '[categorize-local] COMPLETE:',
      {
        userId: user.id,
        clientId,
        clientName: client.name,
        categorized: result.categorized,
        skipped: result.skipped,
      },
    );

    return NextResponse.json({
      success: true,
      clientId,
      categorized: result.categorized,
      skipped: result.skipped,
      message:
        result.categorized > 0
          ? `Categorized ${result.categorized} transaction(s).`
          : 'No uncategorized transactions matched the available local rules.',
    });
  } catch (error: any) {
    console.error(
      '[categorize-local] FAILED:',
      error?.message || error,
    );

    return NextResponse.json(
      {
        error:
          error?.message ||
          'Local categorization failed.',
      },
      {
        status: 500,
      },
    );
  }
}