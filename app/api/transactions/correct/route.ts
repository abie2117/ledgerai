import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../../lib/supabase-server";
import { recordCorrection } from "../../../../lib/categorization";

export async function POST(req: NextRequest) {
  const supabase = createRouteHandlerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { transactionId, clientId, fromCategoryId, toCategoryId } = await req.json();
  if (!transactionId || !clientId || !toCategoryId) return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  try {
    await recordCorrection(transactionId, clientId, fromCategoryId ?? null, toCategoryId, user.id);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}