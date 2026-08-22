// app/api/transactions/correct/route.ts
// FIXED VERSION — matches schema/001_init.sql and schema/003_triggers.sql.

import { NextRequest, NextResponse } from "next/server";
import { getServerUser } from "../../../../lib/auth-server";
import { recordCorrection } from "../../../../lib/categorization";

export async function POST(req: NextRequest) {
  const user = await getServerUser(req);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { transactionId, clientId, fromCategoryId, toCategoryId } = await req.json();

  if (!transactionId || !clientId || !toCategoryId) {
    return NextResponse.json(
      { error: "transactionId, clientId, and toCategoryId are required" },
      { status: 400 }
    );
  }

  try {
    // This call inserts into category_corrections, updates category_mapping_rules,
    // and updates the transaction's ai_category_id + status ('confirmed').
    await recordCorrection(transactionId, clientId, fromCategoryId ?? null, toCategoryId, user.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("recordCorrection failed", err);
    return NextResponse.json({ error: "Could not save correction" }, { status: 500 });
  }
}