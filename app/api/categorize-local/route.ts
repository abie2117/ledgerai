import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../lib/supabase-server";

export async function GET(req: Request) {
  try {
    const supabase = await createRouteHandlerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const { searchParams } = new URL(req.url);
    const clientId = searchParams.get("client_id");
    if (!clientId) return NextResponse.json({ error: "Missing client_id" }, { status: 400 });

    const { data, error } = await supabase
      .from("categories")
      .select("id, name, coa_code, is_default")
      .or(`client_id.eq.${clientId},is_default.eq.true`)
      .order("coa_code", { ascending: true });

    if (error) throw error;
    return NextResponse.json({ success: true, categories: data });
  } catch (err: any) {
    console.error("[categories] error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}