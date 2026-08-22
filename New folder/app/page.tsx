// app/page.tsx
// FIXED: the fetch + mapping logic was sitting at the top level of the
// file with no function wrapper — that's why Next.js threw "Top-level
// await is only supported in EcmaScript Modules". Everything with
// `await` now lives inside `export default async function Page()`,
// which is what Server Components require.

import { cookies } from "next/headers";
import { createServerComponentClient } from "@supabase/auth-helpers-nextjs";
import { TransactionReviewTable } from "../components/TransactionReviewTable";

export default async function Page() {
  const cookieStore = cookies();
  const supabase = createServerComponentClient({ cookies: () => cookieStore });

  // 1. Fetch categories for the correction dropdown.
  const { data: categoriesData } = await supabase
    .from("categories")
    .select("id, name")
    .order("coa_code", { ascending: true });

  // 2. Fetch transactions (client_id included).
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id,
      client_id,
      amount,
      merchant_name,
      description,
      status,
      ai_category_id,
      categories ( name )
    `);

  const dbTransactions = (transactions || []).map((tx: any) => ({
    id: tx.id,
    transaction_id: tx.id,
    client_id: tx.client_id || "",
    merchant_name: tx.merchant_name || tx.description || "Unknown Merchant",
    amount: tx.amount || 0,
    ai_category_id: tx.ai_category_id || "",
    suggested_category: tx.categories?.name || "Uncategorized",
    status: tx.status || "pending_review",
  }));

  return (
    <div className="max-w-5xl mx-auto p-8">
      <h1 className="text-3xl font-bold mb-1">Transaction Review</h1>
      <p className="text-slate-500 mb-6">Review and correct AI category assignments</p>
      <TransactionReviewTable
        initialData={dbTransactions}
        categories={categoriesData || []}
      />
    </div>
  );
}
