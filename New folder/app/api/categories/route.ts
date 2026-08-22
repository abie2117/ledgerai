// app/api/categories/route.ts
// Serves the real category list a CorrectionDrawer needs to let a
// bookkeeper pick a valid categories.id — this didn't exist before,
// which is why the drawer was falling back to a free-text input.

import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";

export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get("clientId");
  if (!clientId) {
    return NextResponse.json({ error: "clientId is required" }, { status: 400 });
  }

  const supabase = createRouteHandlerClient({ cookies });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // RLS on `categories` (schema/001_init.sql) already restricts this to
  // categories belonging to a firm/client the caller has access to — no
  // extra ownership check needed here beyond being authenticated.
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, coa_code")
    .or(`client_id.eq.${clientId},is_default.eq.true`)
    .order("coa_code", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ categories: data ?? [] });
}