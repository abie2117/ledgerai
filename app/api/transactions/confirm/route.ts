import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../../lib/supabase-server";
import { getReviewDecision } from "../../../../lib/review-policy";

export async function POST(req: NextRequest) {
  const supabase = await createRouteHandlerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { transactionId, clientId } = body;
  const transactionIds = Array.isArray(body.transactionIds)
    ? Array.from(
        new Set(
          body.transactionIds.filter(
            (id: unknown): id is string =>
              typeof id === "string" && id.trim().length > 0,
          ),
        ),
      )
    : [];

  if (transactionIds.length > 0) {
    if (!clientId) {
      return NextResponse.json(
        { error: "clientId required for bulk approval" },
        { status: 400 },
      );
    }

    if (transactionIds.length > 100) {
      return NextResponse.json(
        { error: "Bulk approval is limited to 100 transactions at a time" },
        { status: 400 },
      );
    }

    const { data: eligibleTransactions, error: eligibilityError } =
      await supabase
        .from("transactions")
        .select("id, status, ai_category_id, ai_confidence, categorization_source, category")
        .eq("client_id", clientId)
        .in("id", transactionIds);

    if (eligibilityError) {
      return NextResponse.json(
        { error: eligibilityError.message },
        { status: 500 },
      );
    }

    if (
      !eligibleTransactions ||
      eligibleTransactions.length !== transactionIds.length
    ) {
      return NextResponse.json(
        { error: "One or more transactions were not found or not authorized" },
        { status: 404 },
      );
    }

    const nonReviewTransaction = eligibleTransactions.find(
      (transaction) => transaction.status !== "pending_review",
    );

    if (nonReviewTransaction) {
      return NextResponse.json(
        { error: "Only transactions that need review can be bulk approved" },
        { status: 409 },
      );
    }

    const policyException = eligibleTransactions.find(
      (transaction) => getReviewDecision(transaction).state !== "routine",
    );

    if (policyException) {
      return NextResponse.json(
        { error: "Review exceptions must be resolved before confirmation" },
        { status: 409 },
      );
    }

    const { data, error } = await supabase
      .from("transactions")
      .update({ status: "confirmed" })
      .eq("client_id", clientId)
      .in("id", transactionIds)
      .eq("status", "pending_review")
      .select("id");

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!data || data.length !== transactionIds.length) {
      return NextResponse.json(
        { error: "Bulk approval could not confirm every selected transaction" },
        { status: 409 },
      );
    }

    return NextResponse.json({
      success: true,
      approvedCount: data.length,
      transactionIds: data.map((transaction) => transaction.id),
    });
  }

  if (!transactionId || !clientId) {
    return NextResponse.json(
      { error: "transactionId and clientId required" },
      { status: 400 },
    );
  }

  const { data: eligibleTransactions, error: eligibilityError } =
    await supabase
      .from("transactions")
      .select("id, status, ai_category_id, ai_confidence, categorization_source, category")
      .eq("id", transactionId)
      .eq("client_id", clientId);

  if (eligibilityError) {
    return NextResponse.json(
      { error: eligibilityError.message },
      { status: 500 },
    );
  }

  const eligibleTransaction = eligibleTransactions?.[0];

  if (!eligibleTransaction) {
    return NextResponse.json(
      { error: "Not found or not authorized" },
      { status: 404 },
    );
  }

  if (
    eligibleTransaction.status !== "pending_review" ||
    getReviewDecision(eligibleTransaction).state !== "routine"
  ) {
    return NextResponse.json(
      { error: "Only routine transactions awaiting sign-off can be confirmed" },
      { status: 409 },
    );
  }

  const { data, error } = await supabase
    .from("transactions")
    .update({ status: "confirmed" })
    .eq("id", transactionId)
    .eq("client_id", clientId)
    .eq("status", "pending_review")
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data?.length) {
    return NextResponse.json(
      { error: "Transaction changed before it could be confirmed" },
      { status: 409 },
    );
  }

  return NextResponse.json({ success: true, data });
}
