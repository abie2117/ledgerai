import { NextResponse } from "next/server";
import { createRouteHandlerClient } from "../../../lib/supabase-server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

type Transaction = {
  id: string;
  merchant_name: string | null;
  raw_plaid_category: string | null;
  category: string | null;
  client_id: string;
};

function serviceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
      },
    }
  );
}

function categorizeTransaction(
  merchantName: string | null,
  plaidCategory: string | null
): string {
  const merchant = (merchantName || "")
    .toLowerCase()
    .trim();

  const plaid = (plaidCategory || "")
    .toLowerCase()
    .trim();

  // FOOD & DINING
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

  // TRANSPORTATION
  if (
    merchant === "uber" ||
    merchant.startsWith("uber ") ||
    merchant.includes("lyft") ||
    merchant.includes("taxi") ||
    merchant.includes("shell") ||
    merchant.includes("chevron") ||
    merchant.includes("exxon") ||
    merchant.includes("bp ") ||
    merchant.includes("fuel") ||
    merchant.includes("gas station") ||
    plaid.includes("transportation") ||
    plaid.includes("transport")
  ) {
    return "Transportation";
  }

  // AIRLINES / TRAVEL
  if (
    merchant.includes("united airlines") ||
    merchant.includes("american airlines") ||
    merchant.includes("delta") ||
    merchant.includes("southwest") ||
    merchant.includes("jetblue") ||
    merchant.includes("airbnb") ||
    merchant.includes("hotel") ||
    merchant.includes("marriott") ||
    merchant.includes("hilton") ||
    merchant.includes("booking.com") ||
    plaid.includes("airlines") ||
    plaid.includes("lodging") ||
    plaid.includes("travel")
  ) {
    return "Transportation";
  }

  // SOFTWARE & TECHNOLOGY
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

  // BILLS & UTILITIES
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
    plaid.includes("utility") ||
    plaid.includes("bills")
  ) {
    return "Bills & Utilities";
  }

  // SHOPPING
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

  // INCOME / TRANSFERS
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

  return "Uncategorized";
}

export async function POST(req: Request) {
  try {
    /*
     * ---------------------------------------------------------
     * 1. AUTHENTICATE CURRENT USER
     * ---------------------------------------------------------
     */

    const authClient =
      await createRouteHandlerClient();

    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser();

    if (authError || !user) {
      console.error(
        "[categorize-local] Authentication failed:",
        authError
      );

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

    let body: {
      clientId?: string;
    } = {};

    try {
      body = await req.json();
    } catch {
      body = {};
    }

    /*
     * For LedgerAI users, the authenticated Supabase
     * user ID is the correct transaction client ID.
     */

    const clientId =
      body.clientId || user.id;

    /*
     * ---------------------------------------------------------
     * 3. USE SERVICE ROLE FOR SERVER-SIDE UPDATES
     * ---------------------------------------------------------
     *
     * This bypasses Supabase RLS for the controlled
     * server-side categorization operation.
     */

    const db = serviceRoleClient();

    /*
     * ---------------------------------------------------------
     * 4. FETCH TRANSACTIONS
     * ---------------------------------------------------------
     */

    const {
      data: transactions,
      error: fetchError,
    } = await db
      .from("transactions")
      .select(
        "id, merchant_name, raw_plaid_category, category, client_id"
      )
      .eq("client_id", clientId);

    if (fetchError) {
      console.error(
        "[categorize-local] Transaction fetch failed:",
        fetchError
      );

      return NextResponse.json(
        {
          error: fetchError.message,
        },
        {
          status: 500,
        }
      );
    }

    const rows =
      (transactions as Transaction[]) || [];

    console.log(
      `[categorize-local] Found ${rows.length} transactions for client ${clientId}`
    );

    /*
     * ---------------------------------------------------------
     * 5. CATEGORIZE + UPDATE
     * ---------------------------------------------------------
     */

    let updated = 0;
    let unchanged = 0;
    let failed = 0;

    for (const transaction of rows) {
      const newCategory =
        categorizeTransaction(
          transaction.merchant_name,
          transaction.raw_plaid_category
        );

      /*
       * If already correctly categorized,
       * don't perform another database write.
       */

      if (
        transaction.category ===
        newCategory
      ) {
        unchanged++;
        continue;
      }

      const {
        data: updatedRows,
        error: updateError,
      } = await db
        .from("transactions")
        .update({
          category: newCategory,
          updated_at:
            new Date().toISOString(),
        })
        .eq("id", transaction.id)
        .eq("client_id", clientId)
        .select("id, category");

      if (updateError) {
        failed++;

        console.error(
          "[categorize-local] Update failed:",
          {
            transactionId:
              transaction.id,
            merchant:
              transaction.merchant_name,
            error: updateError,
          }
        );

        continue;
      }

      if (
        updatedRows &&
        updatedRows.length > 0
      ) {
        updated++;

        console.log(
          `[categorize-local] ${transaction.merchant_name} → ${newCategory}`
        );
      } else {
        failed++;

        console.error(
          "[categorize-local] Update returned no rows:",
          transaction.id
        );
      }
    }

    /*
     * ---------------------------------------------------------
     * 6. SUCCESS
     * ---------------------------------------------------------
     */

    console.log(
      "[categorize-local] COMPLETE:",
      {
        userId: user.id,
        clientId,
        total: rows.length,
        updated,
        unchanged,
        failed,
      }
    );

    return NextResponse.json({
      success: true,
      total: rows.length,
      updated,
      unchanged,
      failed,
      message:
        `Categorized ${updated} transaction(s).`,
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
