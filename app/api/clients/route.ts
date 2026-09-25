import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '../../../lib/supabase-server';

export async function POST(request: Request) {
  try {
    /*
     * Authenticate the LedgerAI user using the existing
     * server-side Supabase session.
     */
    const supabase = await createServerSupabaseClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    /*
     * Read and validate the submitted client information.
     *
     * firm_id is intentionally NOT accepted from the browser.
     * The server derives firm ownership from firm_users.
     */
    const body = await request.json();

    const businessName =
      typeof body.businessName === 'string'
        ? body.businessName.trim()
        : '';

    if (!businessName) {
      return NextResponse.json(
        { error: 'Business name is required.' },
        { status: 400 },
      );
    }

    if (businessName.length > 200) {
      return NextResponse.json(
        {
          error:
            'Business name must be 200 characters or fewer.',
        },
        { status: 400 },
      );
    }

    /*
     * Service-role access is used only after authenticating
     * the user. Every firm assignment below is verified
     * server-side.
     */
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL;

    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      return NextResponse.json(
        { error: 'Server configuration error.' },
        { status: 500 },
      );
    }

    const admin = createClient(
      supabaseUrl,
      serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    );

    /*
     * Determine which firm the signed-in user belongs to.
     *
     * We do not trust a firm ID supplied by the client.
     */
    const {
      data: memberships,
      error: membershipError,
    } = await admin
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error(
        '[clients] Firm membership lookup failed:',
        membershipError,
      );

      return NextResponse.json(
        { error: 'Unable to verify firm membership.' },
        { status: 500 },
      );
    }

    const firmIds = Array.from(
      new Set(
        (memberships || [])
          .map((membership: any) => membership.firm_id)
          .filter(Boolean),
      ),
    );

    if (firmIds.length === 0) {
      return NextResponse.json(
        { error: 'You do not belong to a firm.' },
        { status: 403 },
      );
    }

    /*
     * The current product flow assumes one active firm context
     * per signed-in bookkeeper.
     *
     * If a user belongs to multiple firms, we must not guess
     * which firm should own the new client.
     */
    if (firmIds.length > 1) {
      return NextResponse.json(
        {
          error:
            'Multiple firm memberships found. Select a firm before adding a client.',
        },
        { status: 409 },
      );
    }

    const firmId = firmIds[0];

    /*
     * Create the client using only confirmed columns from the
     * clients table.
     *
     * id          -> database default
     * status      -> database default ('active')
     * created_at  -> database default
     */
    const {
      data: newClient,
      error: createError,
    } = await admin
      .from('clients')
      .insert({
        firm_id: firmId,
        business_name: businessName,
      })
      .select(
        'id, firm_id, business_name, entity_type, fiscal_year_start, status, created_at',
      )
      .single();

    if (createError) {
      console.error(
        '[clients] Client creation failed:',
        createError,
      );

      return NextResponse.json(
        { error: 'Unable to create client.' },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        success: true,
        client: newClient,
      },
      { status: 201 },
    );
  } catch (error: any) {
    console.error(
      '[clients] Unexpected error:',
      error,
    );

    return NextResponse.json(
      {
        error:
          error?.message ||
          'Unable to create client.',
      },
      { status: 500 },
    );
  }
}