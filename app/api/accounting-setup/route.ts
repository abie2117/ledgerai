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
      return NextResponse.json(
        { error: 'Owner, admin, or bookkeeper access is required to change accounting setup.' },
        { status: 403 },
      );
    }

    const { data: account, error: accountError } = await supabase
      .from('accounts')
      .select('id, coa_category_id, plaid_items!inner(client_id)')
      .eq('id', accountId)
      .eq('plaid_items.client_id', clientId)
      .single();

    if (accountError || !account) {
      return NextResponse.json({ error: 'Connected account not found for this client.' }, { status: 404 });
    }

    let categoryId: string | null = null;

    if (action === 'map') {
      categoryId = typeof body?.categoryId === 'string' ? body.categoryId.trim() : '';
      if (!categoryId) {
        return NextResponse.json({ error: 'categoryId is required.' }, { status: 400 });
      }

      const { data: category, error: categoryError } = await supabase
        .from('categories')
        .select('id')
        .eq('id', categoryId)
        .eq('client_id', clientId)
        .in('account_type', ['asset', 'liability'])
        .eq('is_active', true)
        .eq('is_posting_account', true)
        .single();

      if (categoryError || !category) {
        return NextResponse.json({ error: 'Selected ledger account is not eligible for this client.' }, { status: 409 });
      }
    }

    if (action === 'create_and_map') {
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      const coaCode = typeof body?.coaCode === 'string' ? body.coaCode.trim() : '';
      const accountType = body?.accountType;

      if (!name || !['asset', 'liability'].includes(accountType)) {
        return NextResponse.json(
          { error: 'A ledger account name and Asset or Liability type are required.' },
          { status: 400 },
        );
      }

      const { data: created, error: createError } = await supabase
        .from('categories')
        .insert({
          client_id: clientId,
          name,
          coa_code: coaCode || null,
          account_type: accountType,
          normal_balance: accountType === 'asset' ? 'debit' : 'credit',
          is_posting_account: true,
          is_active: true,
          is_default: false,
        })
        .select('id')
        .single();

      if (createError || !created) {
        return NextResponse.json(
          { error: createError?.message || 'Unable to create the ledger account.' },
          { status: 409 },
        );
      }

      categoryId = created.id;
    }

    const { error: updateError } = await supabase
      .from('accounts')
      .update({ coa_category_id: action === 'unmap' ? null : categoryId })
      .eq('id', accountId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 409 });
    }

    return NextResponse.json({
      success: true,
      accountId,
      coaCategoryId: action === 'unmap' ? null : categoryId,
    });
  } catch (error) {
    console.error('[accounting-setup] Unexpected error:', error);
    return NextResponse.json({ error: 'Unable to update accounting setup.' }, { status: 500 });
  }
}
