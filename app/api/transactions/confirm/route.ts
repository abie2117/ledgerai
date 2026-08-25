import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../../lib/supabase-server";

export async function POST(req: NextRequest) {
  const supabase = createRouteHandlerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { transactionId, clientId } = await req.json();
  if (!transactionId) return NextResponse.json({ error: "transactionId required" }, { status: 400 });
  let query = supabase.from("transactions").update({ status: "confirmed" }).eq("id", transactionId);
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query.select();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "Not found or not authorized" }, { status: 404 });
  return NextResponse.json({ success: true, data });
}