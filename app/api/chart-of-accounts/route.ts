import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase-server';

const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'];
async function context(clientId: string) {
  const supabase = await createServerSupabaseClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: NextResponse.json({ error: 'Not authenticated.' }, { status: 401 }) };
  const { data: client } = await supabase.from('clients').select('firm_id').eq('id', clientId).maybeSingle();
  if (!client) return { error: NextResponse.json({ error: 'Client not found or unavailable.' }, { status: 404 }) };
  const { data: membership } = await supabase.from('firm_users').select('role').eq('firm_id', client.firm_id).eq('user_id', user.id).maybeSingle();
  if (!membership) return { error: NextResponse.json({ error: 'Not authorized for this client.' }, { status: 403 }) };
  return { supabase, canManage: ['owner', 'admin', 'bookkeeper'].includes(membership.role) };
}

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get('clientId')?.trim();
  if (!clientId) return NextResponse.json({ error: 'clientId is required.' }, { status: 400 });
  const c = await context(clientId);
  if ('error' in c) return c.error;
  const { data, error } = await c.supabase.from('categories')
    .select('id, name, coa_code, account_type, normal_balance, is_active, is_posting_account')
    .eq('client_id', clientId).order('coa_code').order('name');
  if (error) return NextResponse.json({ error: 'Unable to load Chart of Accounts.' }, { status: 500 });
  return NextResponse.json({ accounts: data || [], canManage: c.canManage });
}

export async function POST(req: Request) {
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid request.' }, { status: 400 }); }
  const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const code = typeof body?.coaCode === 'string' ? body.coaCode.trim() : '';
  const type = body?.accountType;
  if (!clientId || !name || name.length > 120 || !code || code.length > 30 || !TYPES.includes(type)) {
    return NextResponse.json({ error: 'A client, account name, code, and valid type are required.' }, { status: 400 });
  }
  const c = await context(clientId);
  if ('error' in c) return c.error;
  if (!c.canManage) return NextResponse.json({ error: 'Owner, admin, or bookkeeper access is required.' }, { status: 403 });
  const { data, error } = await c.supabase.rpc('create_client_ledger_account', {
    p_client_id: clientId, p_name: name, p_coa_code: code, p_account_type: type,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 409 });
  if (!data) return NextResponse.json({ error: 'Account creation did not return a result.' }, { status: 500 });
  return NextResponse.json({ success: true, categoryId: data });
}
