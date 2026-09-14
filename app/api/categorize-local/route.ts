import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../lib/supabase-server";

export const dynamic = "force-dynamic";

type Transaction = {
  id: string;
  merchant_name: string | null;
  raw_plaid_category: string | null;
  category: string | null;
  client_id: string;
};

function categorizeTransaction(
  merchantName: string | null,
  plaidCategory: string | null
): string {
  const merchant = (merchantName || "").toLowerCase().trim();
  const plaid = (plaidCategory || "").toLowerCase().trim();

  // Food & Dining
  if (
    merchant.includes("mcdonald") ||
    merchant.includes("starbucks") ||
    merchant.includes("restaurant") ||
    merchant.includes("doordash") ||
    merchant.includes("uber eats") ||
    merchant.includes("grubhub") ||
    merchant.includes("subway") ||
    merchant.includes("chipotle") ||
    merchant.includes("pizza") ||
    merchant.includes("burger") ||
    plaid.includes("food") ||
    plaid.includes("restaurant")
  ) {
    return "Food & Dining";
  }

  // Transportation
  if (
    merchant.includes("uber") ||
    merchant.includes("lyft") ||
    merchant.includes("taxi") ||
    merchant.includes("shell") ||
    merchant.includes("chevron") ||
    merchant.includes("exxon") ||
    merchant.includes("bp ") ||
    merchant.includes("fuel") ||
    merchant.includes("gas station") ||
    plaid.includes("transportation") ||
    plaid.includes("travel")
  ) {
    return "Transportation";
  }

  // Airlines / travel
  if (
    merchant.includes("united airlines") ||
    merchant.includes("american airlines") ||
    merchant.includes("delta") ||
    merchant.includes("southwest") ||
    merchant.includes("airbnb") ||
    merchant.includes("hotel") ||
    merchant.includes("marriott") ||
    merchant.includes("hilton") ||
    merchant.includes("booking.com") ||
    plaid.includes("airlines") ||
    plaid.includes("lodging")
  ) {
    return "Transportation";
  }

  // Software & Technology
  if (
    merchant.includes("openai") ||
    merchant.includes("anthropic") ||
    merchant.includes("vercel") ||
    merchant.includes("github") ||
    merchant.includes("google cloud") ||
    merchant.includes("aws") ||
    merchant.includes("amazon web services") ||
    merchant.includes("microsoft") ||
    merchant.includes("adobe") ||
    merchant.includes("dropbox") ||
    merchant.includes("notion") ||
    merchant.includes("slack") ||
    merchant.includes("zoom") ||
    plaid.includes("software") ||
    plaid.includes("technology")
  ) {
    return "Software & Tech";
  }

  // Bills & Utilities
  if (
    merchant.includes("electric") ||
    merchant.includes("power") ||
    merchant.includes("water") ||
    merchant.includes("internet") ||
    merchant.includes("comcast") ||
    merchant.includes("verizon") ||
    merchant.includes("at&t") ||
    merchant.includes("t-mobile") ||
    merchant.includes("utility") ||
    merchant.includes("insurance") ||
    plaid.includes("utilities") ||
    plaid.includes("bills")
  ) {
    return "Bills & Utilities";
  }

  // Shopping
  if (
    merchant.includes("amazon") ||
    merchant.includes("walmart") ||
    merchant.includes("target") ||
    merchant.includes("costco") ||
    merchant.includes("ebay") ||
    merchant.includes("etsy") ||
    merchant.includes("shop") ||
    plaid.includes("shops") ||
    plaid.includes("shopping")
  ) {
    return "Shopping";
  }

  // Income / transfers
  if (
    merchant.includes("payroll") ||
    merchant.includes("salary") ||
    merchant.includes("direct deposit") ||
    merchant.includes("deposit") ||
    merchant.includes("income") ||
    merchant.includes("transfer")
  ) {
    return "Transfer / Income";
  }

  // Generic Plaid category fallbacks
  if (plaid.includes("food")) {
    return "Food & Dining";
  }

  if (
    plaid.includes("transport") ||
    plaid.includes("travel")
  ) {
    return "Transportation";
  }

  if (
    plaid.includes("shop") ||
    plaid.includes("merchandise")
  ) {
    return "Shopping";
  }

  if (
    plaid.includes("utility") ||
    plaid.includes("bill")
  ) {
    return "Bills & Utilities";
  }

  return "Uncategorized";
}

export async function POST(req: Request) {
  try {
    /*
     * ---------------------------------------------------------
     * 1. AUTHENTICATE USER
     * ---------------------------------------------------------
     */

    const supabase = await createRouteHandlerClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        {
          error: "Not authenticated",
        },
        {
          status: 401,
        }
      );
    }

    /*
     * ---------------------------------------------------------
     * 2. READ REQUEST
     * ---------------------------------------------------------
     */

    let body: { clientId?: string } = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    /*
     * The dashboard sends clientId.
     * For a normal LedgerAI user, the authenticated
     * Supabase user ID is the safest client ID.
     */

    const clientId =
      body.clientId || user.id;

    /*
     * ---------------------------------------------------------
     * 3. GET USER TRANSACTIONS
     * ---------------------------------------------------------
     */

    const {
      data: transactions,
      error: transactionFetchError,
    } = await supabase
      .from("transactions")
      .select(
        "id, merchant_name, raw_plaid_category, category, client_id"
      )
      .eq("client_id", clientId);

    if (transactionFetchError) {
      console.error(
        "[categorize-local] Failed to fetch transactions:",
        transactionFetchError
      );

      return NextResponse.json(
        {
          error:
            transactionFetchError.message,
        },
        {
          status: 500,
        }
      );
    }

    const rows =
      (transactions as Transaction[]) || [];

    /*
     * ---------------------------------------------------------
     * 4. CATEGORIZE TRANSACTIONS
     * ---------------------------------------------------------
     */

    let updated = 0;
    let unchanged = 0;

    for (const transaction of rows) {
      const newCategory =
        categorizeTransaction(
          transaction.merchant_name,
          transaction.raw_plaid_category
        );

      /*
       * Don't repeatedly write the same category.
       */

      if (
        transaction.category ===
        newCategory
      ) {
        unchanged++;
        continue;
      }

      const {
        error: updateError,
      } = await supabase
        .from("transactions")
        .update({
          category: newCategory,
          updated_at:
            new Date().toISOString(),
        })
        .eq("id", transaction.id)
        .eq("client_id", clientId);

      if (updateError) {
        console.error(
          "[categorize-local] Failed to update transaction:",
          transaction.id,
          updateError
        );

        continue;
      }

      updated++;
    }

    /*
     * ---------------------------------------------------------
     * 5. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      "[categorize-local] Completed:",
      {
        userId: user.id,
        clientId,
        total: rows.length,
        updated,
        unchanged,
      }
    );

    return NextResponse.json({
      success: true,
      total: rows.length,
      updated,
      unchanged,
      message:
        `Categorization completed. ${updated} transaction(s) updated.`,
    });
  } catch (error: any) {
    console.error(
      "[categorize-local] FAILED:",
      error?.message || error
    );

    return NextResponse.json(
      {
        error:
          error?.message ||
          "Local categorization failed.",
      },
      {
        status: 500,
      }
    );
  }
}
