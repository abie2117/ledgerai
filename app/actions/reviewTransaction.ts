"use server";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { revalidatePath } from "next/cache";

function getSupabase() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name) { return cookieStore.get(name)?.value; },
        set(name, value, options) { cookieStore.set({ name, value, ...options }); },
        remove(name, options) { cookieStore.set({ name, value: "", ...options }); },
      },
    }
  );
}

export async function confirmTransaction({ transactionId, clientId }: { transactionId: string; clientId: string }) {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  console.log(`[confirmTransaction] auth.getUser(): ${user?.id ?? "null"}`);
  if (!user) return { success: false, error: "Not authenticated" };

  const { data, error } = await supabase
    .from("transactions")
    .update({ status: "confirmed" })
    .eq("id", transactionId)
    .eq("client_id", clientId)
    .select();

  if (error) { console.error("[confirmTransaction] failed:", error.message); return { success: false, error: error.message }; }
  if (!data?.length) return { success: false, error: "Transaction not found or not authorized." };
  revalidatePath("/");
  return { success: true };
}

export async function correctTransaction({ transactionId, clientId, fromCategoryId, toCategoryId }: { transactionId: string; clientId: string; fromCategoryId: string | null; toCategoryId: string }) {
  const supabase = getSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  console.log(`[correctTransaction] auth.getUser(): ${user?.id ?? "null"}`);
  if (!user) return { success: false, error: "Not authenticated" };

  const { error: updateError } = await supabase
    .from("transactions")
    .update({ ai_category_id: toCategoryId, status: "confirmed" })
    .eq("id", transactionId)
    .eq("client_id", clientId);
  if (updateError) return { success: false, error: updateError.message };

  const { error: auditError } = await supabase.from("category_corrections").insert({
    transaction_id: transactionId, client_id: clientId,
    from_category_id: fromCategoryId, to_category_id: toCategoryId, corrected_by: user.id,
  });
  if (auditError) { console.error("[correctTransaction] audit failed:", auditError.message); return { success: false, error: auditError.message }; }
  revalidatePath("/");
  return { success: true };
}