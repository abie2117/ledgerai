// app/actions/reviewTransaction.ts
// Two Server Actions: confirmTransaction and correctTransaction.
//
// KEY FIX in this version: the auth check now logs UNCONDITIONALLY,
// before branching on whether user exists. Previously, a null user
// caused a silent early return with zero console output — which is
// indistinguishable from the function never running at all. Now you'll
// always see exactly one of these two lines for every click:
//   "[confirmTransaction] auth.getUser() resolved to: <id>"
//   "[confirmTransaction] auth.getUser() resolved to: null — session not found"

"use server";

import { cookies } from "next/headers";
import { createServerActionClient } from "@supabase/auth-helpers-nextjs";
import { revalidatePath } from "next/cache";

interface ConfirmTransactionArgs {
  transactionId: string;
  clientId: string;
}

export async function confirmTransaction({
  transactionId,
  clientId,
}: ConfirmTransactionArgs): Promise<{ success: boolean; error?: string }> {
  const cookieStore = cookies();
  const supabase = createServerActionClient({ cookies: () => cookieStore });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Unconditional log — fires no matter which branch we take next.
  console.log(`[confirmTransaction] auth.getUser() resolved to: ${user?.id ?? "null — session not found"}`);

  if (!user) {
    return { success: false, error: "Not authenticated — no user session found in this Server Action." };
  }

  console.log("[confirmTransaction] Confirming transaction:", transactionId, "as user:", user.id);

  const { data, error } = await supabase
    .from("transactions")
    .update({ status: "confirmed" })
    .eq("id", transactionId)
    .eq("client_id", clientId)
    .select();

  if (error) {
    console.error("[confirmTransaction] Confirm failed:", error.message, "auth.uid():", user.id);
    return { success: false, error: error.message };
  }

  if (!data || data.length === 0) {
    console.error("[confirmTransaction] Matched zero rows — likely RLS blocked it. auth.uid():", user.id);
    return { success: false, error: "Transaction not found or not authorized." };
  }

  revalidatePath("/");
  return { success: true };
}

interface CorrectTransactionArgs {
  transactionId: string;
  clientId: string;
  fromCategoryId: string | null;
  toCategoryId: string;
}

export async function correctTransaction({
  transactionId,
  clientId,
  fromCategoryId,
  toCategoryId,
}: CorrectTransactionArgs): Promise<{ success: boolean; error?: string }> {
  const cookieStore = cookies();
  const supabase = createServerActionClient({ cookies: () => cookieStore });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.log(`[correctTransaction] auth.getUser() resolved to: ${user?.id ?? "null — session not found"}`);

  if (!user) {
    return { success: false, error: "Not authenticated — no user session found in this Server Action." };
  }

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ ai_category_id: toCategoryId, status: "confirmed" })
    .eq("id", transactionId)
    .eq("client_id", clientId);

  if (updateError) {
    console.error("[correctTransaction] Update failed:", updateError.message, "auth.uid():", user.id);
    return { success: false, error: `Could not update transaction: ${updateError.message}` };
  }

  const { error: auditError } = await supabase.from("category_corrections").insert({
    transaction_id: transactionId,
    client_id: clientId,
    from_category_id: fromCategoryId,
    to_category_id: toCategoryId,
    corrected_by: user.id,
  });

  if (auditError) {
    console.error("[correctTransaction] Audit insert failed:", auditError.message, "auth.uid():", user.id);
    return { success: false, error: `Correction saved but audit log failed: ${auditError.message}` };
  }

  revalidatePath("/");
  return { success: true };
}