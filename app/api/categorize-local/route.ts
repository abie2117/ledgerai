import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../lib/supabase-server";
import { categorizeWithLocalRules } from "../../../lib/categorization";

export async function POST(req: Request) {
  try {
    const supabase = await createRouteHandlerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const rawId = body.clientId || body.client_id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let targetClientId: string | null = uuidRegex.test(rawId ?? "") ? rawId : null;

    if (!targetClientId && (body.client_name || rawId)) {
      const { data: matched } = await supabase
        .from("clients")
        .select("id")
        .eq("business_name", body.client_name || rawId)
        .maybeSingle();
      targetClientId = matched?.id || null;
    }

    if (!targetClientId) return NextResponse.json({ error: "Could not resolve clientId" }, { status: 400 });

    console.log("[categorize-local] Running for clientId:", targetClientId);
    const result = await categorizeWithLocalRules(targetClientId);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    console.error("[categorize-local] error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
