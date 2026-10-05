import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

const ACCOUNTING_ROLES = new Set(['owner', 'admin', 'bookkeeper']);

async function getContext(clientId: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  }

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, firm_id')
    .eq('id', clientId)
    .single();

  if (clientError || !client) {
    return { error: NextResponse.json({ error: 'Client not found or unavailable.' }, { status: 404 }) };
  }

  const { data: membership } = await supabase
    .from('firm_users')
    .select('role')
    .eq('firm_id', client.firm_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!membership) {
    return { error: NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 }) };
  }

  return {
    supabase,
    user,
    canManage: ACCOUNTING_ROLES.has(membership.role),
  };
}

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get('clientId');

  if (!clientId) {
    return NextResponse.json({ error: 'clientId is required.' }, { status: 400 });
  }

  const context = await getContext(clientId);
  if ('error' in context) return context.error;

  const { supabase, canManage } = context;

  const [{ data: accounts, error: accountError }, { data: categories, error: categoryError }] =
    await Promise.all([
      supabase
        .from('accounts')
        .select('id, name, mask, type, subtype, coa_category_id, plaid_items!inner(client_id)')
        .eq('plaid_items.client_id', clientId)
        .order('name', { ascending: true }),
      supabase
        .from('categories')
        .select('id, name, coa_code, account_type, normal_balance, is_active, is_posting_account')
        .eq('client_id', clientId)
        .in('account_type', ['asset', 'liability'])
        .eq('is_active', true)
        .eq('is_posting_account', true)
        .order('coa_code', { ascending: true })
        .order('name', { ascending: true }),
    ]);

  if (accountError || categoryError) {
    return NextResponse.json(
      { error: accountError?.message || categoryError?.message || 'Unable to load accounting setup.' },
      { status: 500 },
    );
  }

  return NextResponse.json({
    accounts: accounts || [],
    categories: categories || [],
    canManage,
  });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
    const action = body?.action;

    if (!clientId || !accountId || !['map', 'create_and_map', 'unmap'].includes(action)) {
      return NextResponse.json({ error: 'Valid clientId, accountId, and action are required.' }, { status: 400 });
    }

    const context = await getContext(clientId);
    if ('error' in context) return context.error;
    const { supabase, canManage } = context;

    if (!canManage) {
      return NextResponse.json({ error: 'Owner, admin, or bookkeeper access is required to change accounting setup.' }, { status: 403 });
    }

    const categoryId = action === 'map' && typeof body?.categoryId === 'string' ? body.categoryId.trim() : null;
    const name = action === 'create_and_map' && typeof body?.name === 'string' ? body.name.trim() : null;
    const coaCode = action === 'create_and_map' && typeof body?.coaCode === 'string' ? body.coaCode.trim() : null;
    const accountType = action === 'create_and_map' && ['asset', 'liability'].includes(body?.accountType) ? body.accountType : null;

    if (action === 'map' && !categoryId) {
      return NextResponse.json({ error: 'categoryId is required.' }, { status: 400 });
    }
    if (action === 'create_and_map' && (!name || !accountType)) {
      return NextResponse.json({ error: 'A ledger account name and Asset or Liability type are required.' }, { status: 400 });
    }

    const { data, error } = await supabase.rpc('mutate_accounting_setup', {
      p_client_id: clientId,
      p_account_id: accountId,
      p_action: action,
      p_category_id: categoryId || null,
      p_name: name || null,
      p_coa_code: coaCode || null,
      p_account_type: accountType || null,
    });

    if (error) {
      console.error('[accounting-setup] Atomic mutation failed:', { clientId, accountId, action, code: error.code, message: error.message });
      return NextResponse.json({ error: error.message || 'Unable to update accounting setup.' }, { status: 409 });
    }

    const result = Array.isArray(data) ? data[0] : null;
    if (!result?.account_id) {
      return NextResponse.json({ error: 'Accounting setup mutation did not return a result.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      accountId: result.account_id,
      coaCategoryId: result.coa_category_id ?? null,
    });
  } catch (error) {
    console.error('[accounting-setup] Unexpected error:', error);
    return NextResponse.json({ error: 'Unable to update accounting setup.' }, { status: 500 });
  }
}
