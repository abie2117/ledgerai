import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createServerSupabaseClient } from '../../../lib/supabase-server';
import { recordCorrection } from '../../../lib/categorization';

export async function POST(request: Request) {
  try {
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

    const body = await request.json();

    const transactionId = body.transactionId;
    const clientId = body.clientId;
    const toCategoryId = body.categoryId;

    if (!transactionId || !clientId || !toCategoryId) {
      return NextResponse.json(
        {
          error:
            'transactionId, clientId, and categoryId are required.',
        },
        { status: 400 },
      );
    }

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
     * Verify that the signed-in user belongs to a firm.
     */
    const {
      data: memberships,
      error: membershipError,
    } = await admin
      .from('firm_users')
      .select('firm_id')
      .eq('user_id', user.id);

    if (membershipError) {
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

    /*
     * Verify that the selected client belongs to one
     * of the user's firms.
     */
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

    /*
     * Verify that the transaction belongs to this client.
     * We also need its existing canonical category so the
     * correction history records what changed.
     */
    const {
      data: transaction,
      error: transactionError,
    } = await admin
      .from('transactions')
      .select('id, client_id, ai_category_id')
      .eq('id', transactionId)
      .eq('client_id', clientId)
      .maybeSingle();

    if (transactionError) {
      return NextResponse.json(
        { error: 'Unable to verify transaction.' },
        { status: 500 },
      );
    }

    if (!transaction) {
      return NextResponse.json(
        {
          error:
            'Transaction was not found for the selected client.',
        },
        { status: 404 },
      );
    }

    /*
     * The category must either be a global LedgerAI category
     * or a category belonging specifically to this client.
     */
    const {
      data: category,
      error: categoryError,
    } = await admin
      .from('categories')
      .select('id, name, client_id')
      .eq('id', toCategoryId)
      .or(
        `client_id.eq.${clientId},client_id.is.null`,
      )
      .maybeSingle();

    if (categoryError) {
      return NextResponse.json(
        { error: 'Unable to verify category.' },
        { status: 500 },
      );
    }

    if (!category) {
      return NextResponse.json(
        {
          error:
            'Selected category is not available for this client.',
        },
        { status: 400 },
      );
    }

    /*
     * No correction is necessary when the transaction already
     * has the selected canonical category.
     */
    if (transaction.ai_category_id === toCategoryId) {
      return NextResponse.json({
        success: true,
        unchanged: true,
        transactionId,
        category: {
          id: category.id,
          name: category.name,
        },
      });
    }

    /*
     * recordCorrection() performs the canonical bookkeeping work:
     *
     * - records category_corrections
     * - updates ai_category_id
     * - synchronizes the legacy category text
     * - marks the transaction confirmed
     * - teaches the merchant mapping rule for this client
     */
    await recordCorrection(
      transactionId,
      clientId,
      transaction.ai_category_id || null,
      toCategoryId,
      user.id,
    );

    return NextResponse.json({
      success: true,
      unchanged: false,
      transactionId,
      clientId,
      category: {
        id: category.id,
        name: category.name,
      },
    });
  } catch (error: any) {
    console.error(
      '[category-correction] Unexpected error:',
      error,
    );

    return NextResponse.json(
      {
        error:
          error?.message ||
          'Unable to save category correction.',
      },
      { status: 500 },
    );
  }
}