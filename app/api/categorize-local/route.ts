import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '../../../lib/supabase-server';
import { categorizeWithLocalRules } from '../../../lib/categorization';

export async function POST(request: Request) {
  try {
    // Authenticate the currently signed-in bookkeeper/user.
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

    // Read the selected client explicitly.
    const body = await request.json();

    const clientId = body.clientId || body.client_id;

    if (!clientId) {
      return NextResponse.json(
        { error: 'Missing clientId' },
        { status: 400 },
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(
        'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.',
      );

      return NextResponse.json(
        { error: 'Server configuration error' },
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

    // Find the firms this authenticated user belongs to.
    const {
      data: memberships,
      error: membershipError,
    } = await admin
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
      console.error(
        'Unable to verify firm membership:',
        membershipError,
      );

      return NextResponse.json(
        { error: 'Unable to verify firm membership.' },
        { status: 500 },
      );
    }

    const firmIds = (memberships || [])
      .map((membership: any) => membership.firm_id)
      .filter(Boolean);

    if (firmIds.length === 0) {
      return NextResponse.json(
        { error: 'You do not belong to a firm.' },
        { status: 403 },
      );
    }

    // Verify that the selected client belongs to one of the
    // authenticated user's firms.
    //
    // These are the client columns already used successfully
    // by the dashboard.
    const {
      data: client,
      error: clientError,
    } = await admin
      .from('clients')
      .select('id, firm_id, business_name')
      .eq('id', clientId)
      .in('firm_id', firmIds)
      .maybeSingle();

    if (clientError) {
      console.error(
        'Unable to verify client:',
        clientError,
      );

      return NextResponse.json(
        { error: 'Unable to verify client.' },
        { status: 500 },
      );
    }

    if (!client) {
      return NextResponse.json(
        {
          error:
            'Selected client was not found or does not belong to your firm.',
        },
        { status: 403 },
      );
    }

    console.log(
      'Running local categorization for client:',
      client.id,
      client.business_name,
    );

    // Run the centralized categorization logic.
    const result = await categorizeWithLocalRules(client.id);

    return NextResponse.json({
      success: true,
      clientId: client.id,
      clientName: client.business_name,
      categorized: result.categorized,
      skipped: result.skipped,
    });
  } catch (error: any) {
    console.error(
      'Local categorization route error:',
      error,
    );

    return NextResponse.json(
      {
        error:
          error?.message ||
          'Unable to categorize transactions.',
      },
      { status: 500 },
    );
  }
}