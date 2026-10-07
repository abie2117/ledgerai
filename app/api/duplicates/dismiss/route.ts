import { NextRequest, NextResponse } from 'next/server';
import { createRouteHandlerClient } from '../../../../lib/supabase-server';

export async function POST(req: NextRequest) {
  const supabase = await createRouteHandlerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const candidateId =
    typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
  const clientId =
    typeof body.clientId === 'string' ? body.clientId.trim() : '';

  if (!candidateId || !clientId) {
    return NextResponse.json(
      { error: 'candidateId and clientId are required' },
      { status: 400 },
    );
  }

  const { data: candidate, error: candidateError } = await supabase
    .from('duplicate_candidates')
    .select('id, status')
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (candidateError) {
    return NextResponse.json(
      { error: candidateError.message },
      { status: 500 },
    );
  }

  if (!candidate) {
    return NextResponse.json(
      { error: 'Duplicate candidate not found or not authorized' },
      { status: 404 },
    );
  }

  if (candidate.status !== 'open') {
    return NextResponse.json(
      { error: 'Only open duplicate candidates can be dismissed' },
      { status: 409 },
    );
  }

  const { data: dismissed, error: dismissError } = await supabase
    .from('duplicate_candidates')
    .update({
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
      resolved_by: user.id,
    })
    .eq('id', candidateId)
    .eq('client_id', clientId)
    .eq('status', 'open')
    .select('id, status')
    .maybeSingle();

  if (dismissError) {
    return NextResponse.json(
      { error: dismissError.message },
      { status: 500 },
    );
  }

  if (!dismissed) {
    return NextResponse.json(
      { error: 'Duplicate candidate changed before it could be dismissed' },
      { status: 409 },
    );
  }

  return NextResponse.json({
    success: true,
    candidateId: dismissed.id,
    status: dismissed.status,
  });
}
