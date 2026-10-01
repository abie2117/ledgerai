import { NextRequest, NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../../lib/supabase-server";

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
        .select("id, status")
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

  if (!transactionId) {
    return NextResponse.json(
      { error: "transactionId required" },
      { status: 400 },
    );
  }

  let query = supabase
    .from("transactions")
    .update({ status: "confirmed" })
    .eq("id", transactionId);

  if (clientId) {
    query = query.eq("client_id", clientId);
  }

  const { data, error } = await query.select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data?.length) {
    return NextResponse.json(
      { error: "Not found or not authorized" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data });
}
