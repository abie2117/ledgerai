import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../lib/supabase-server";
import { createClient } from "@supabase/supabase-js";

async function categorizeWithLocalRules(clientId: string): Promise<{ categorized: number; skipped: number }> {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );

  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, merchant_name, raw_plaid_category")
    .eq("client_id", clientId)
    .eq("status", "pending_review")
    .is("ai_category_id", null);

  if (error) throw error;
  if (!pending?.length) return { categorized: 0, skipped: 0 };

  const { data: categories } = await supabase
    .from("categories")
    .select("id, name")
    .or(`client_id.eq.${clientId},is_default.eq.true`);

  if (!categories?.length) return { categorized: 0, skipped: pending.length };

  const rules = [
    { pattern: /credit card.*payment|card.*payment/i, hints: ["credit card", "payment"] },
    { pattern: /intrst|interest/i, hints: ["interest", "transfer"] },
    { pattern: /aws|cloud|hosting/i, hints: ["software", "subscriptions"] },
    { pattern: /office depot|supplies/i, hints: ["office"] },
    { pattern: /transfer/i, hints: ["transfer"] },
    { pattern: /payment.*credit card/i, hints: ["credit card", "payment"] },
    { pattern: /transfer.*credit/i, hints: ["transfer", "interest"] },
  ];

  let categorized = 0;
  let skipped = 0;

  for (const txn of pending) {
    const searchText = `${txn.merchant_name ?? ""} ${txn.raw_plaid_category ?? ""}`;
    let matchedId: string | null = null;

    for (const rule of rules) {
      if (!rule.pattern.test(searchText)) continue;
      const hit = categories.find((c) => rule.hints.some((h) => c.name.toLowerCase().includes(h)));
      if (hit) {
        matchedId = hit.id;
        break;
      }
    }

    if (matchedId) {
      await supabase
        .from("transactions")
        .update({ ai_category_id: matchedId, ai_confidence: 1.0 })
        .eq("id", txn.id);
      categorized++;
    } else {
      skipped++;
    }
  }

  return { categorized, skipped };
}

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
