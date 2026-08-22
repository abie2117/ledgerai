// lib/categorization.ts
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

function supabaseAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

interface PendingTxn {
  id: string;
  merchant_name: string | null;
  amount: number;
  raw_plaid_category: string | null;
}

/**
 * Builds a database-ready transaction record from a Plaid transaction object.
 */
export function buildTransactionRecord(plaidTx: any, clientId: string) {
  return {
    client_id: clientId,
    plaid_transaction_id: plaidTx.transaction_id,
    amount: plaidTx.amount,
    date: plaidTx.date,
    merchant_name: plaidTx.merchant_name || plaidTx.name || "Unknown Merchant",
    raw_plaid_category: Array.isArray(plaidTx.category)
      ? plaidTx.category.join(" > ")
      : plaidTx.category || null,
    status: "pending_review",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function categorizePendingTransactions(clientId: string) {
  const supabase = supabaseAdmin();

  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, merchant_name, amount, raw_plaid_category")
    .eq("client_id", clientId)
    .eq("status", "pending_review")
    .is("ai_category_id", null);
  if (error) throw error;
  if (!pending?.length) return;

  const { data: categories } = await supabase
    .from("categories")
    .select("id, name, coa_code")
    .or(`client_id.eq.${clientId},is_default.eq.true`);

  const { data: rules } = await supabase
    .from("category_mapping_rules")
    .select("merchant_pattern, category_id, confidence_score")
    .eq("client_id", clientId);

  const ruleMap = new Map((rules ?? []).map((r) => [normalizeMerchant(r.merchant_pattern), r]));

  const needsClaude: PendingTxn[] = [];

  for (const txn of pending as PendingTxn[]) {
    const key = normalizeMerchant(txn.merchant_name ?? "");
    const rule = ruleMap.get(key);
    if (rule && rule.confidence_score >= 0.85) {
      await applyCategory(supabase, txn.id, rule.category_id, rule.confidence_score);
      await bumpRuleUsage(supabase, clientId, key);
    } else {
      needsClaude.push(txn);
    }
  }

  if (needsClaude.length) {
    await categorizeBatchWithClaude(supabase, clientId, needsClaude, categories ?? []);
  }
}

function normalizeMerchant(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

async function applyCategory(
  supabase: ReturnType<typeof supabaseAdmin>,
  transactionId: string,
  categoryId: string,
  confidence: number
) {
  await supabase
    .from("transactions")
    .update({ ai_category_id: categoryId, ai_confidence: confidence, updated_at: new Date().toISOString() })
    .eq("id", transactionId);
}

async function bumpRuleUsage(supabase: ReturnType<typeof supabaseAdmin>, clientId: string, merchantKey: string) {
  await supabase.rpc("increment_rule_hit_count", {
    p_client_id: clientId,
    p_merchant_pattern: merchantKey,
  });
}

async function categorizeBatchWithClaude(
  supabase: ReturnType<typeof supabaseAdmin>,
  clientId: string,
  txns: PendingTxn[],
  categories: { id: string; name: string; coa_code: string | null }[]
) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const categoryList = categories.map((c) => `- ${c.id}: ${c.name}${c.coa_code ? ` (${c.coa_code})` : ""}`).join("\n");
  const txnList = txns.map((t, i) => `${i}. merchant="${t.merchant_name ?? "unknown"}", amount=${t.amount}, plaid_category="${t.raw_plaid_category ?? "none"}"`).join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    system: "You are a bookkeeping categorization engine. Choose exactly one category_id from the provided list for each transaction. Never invent a category_id. Respond ONLY with a JSON array, no prose, no markdown.",
    messages: [{
      role: "user",
      content: `Chart of accounts:\n${categoryList}\n\nTransactions:\n${txnList}\n\nRespond: [{"index": 0, "category_id": "...", "confidence": 0.0-1.0}]`,
    }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No text response from Claude");
  const results: { index: number; category_id: string; confidence: number }[] = JSON.parse(textBlock.text);

  for (const r of results) {
    const txn = txns[r.index];
    if (!txn) continue;
    await applyCategory(supabase, txn.id, r.category_id, r.confidence);
    if (txn.merchant_name) {
      await supabase.from("category_mapping_rules").upsert(
        { client_id: clientId, merchant_pattern: normalizeMerchant(txn.merchant_name), category_id: r.category_id, confidence_score: r.confidence },
        { onConflict: "client_id,merchant_pattern" }
      );
    }
  }
}

export async function recordCorrection(
  transactionId: string,
  clientId: string,
  fromCategoryId: string | null,
  toCategoryId: string,
  correctedBy: string
) {
  const supabase = supabaseAdmin();
  await supabase.from("category_corrections").insert({
    transaction_id: transactionId,
    client_id: clientId,
    from_category_id: fromCategoryId,
    to_category_id: toCategoryId,
    corrected_by: correctedBy,
  });
  const { data: txn } = await supabase.from("transactions").select("merchant_name").eq("id", transactionId).single();
  if (txn?.merchant_name) {
    const key = normalizeMerchant(txn.merchant_name);
    await supabase.from("category_mapping_rules").upsert(
      { client_id: clientId, merchant_pattern: key, category_id: toCategoryId, confidence_score: 0.6 },
      { onConflict: "client_id,merchant_pattern" }
    );
  }
  await supabase
    .from("transactions")
    .update({ ai_category_id: toCategoryId, status: "confirmed", updated_at: new Date().toISOString() })
    .eq("id", transactionId);
}

// ============================================================
// LOCAL RULE-BASED CATEGORIZER — no API cost, for testing only.
// ============================================================

const LOCAL_KEYWORD_RULES: { pattern: RegExp; categoryNameHints: string[] }[] = [
  { pattern: /credit card.*payment|card.*payment/i, categoryNameHints: ["credit card", "card payment", "payment"] },
  { pattern: /intrst|interest/i, categoryNameHints: ["interest", "interest expense", "interest income", "transfer"] },
  { pattern: /aws|cloud|hosting|azure|gcp|digitalocean/i, categoryNameHints: ["software", "subscriptions", "software & subscriptions", "cloud"] },
  { pattern: /office depot|staples|office|supplies/i, categoryNameHints: ["office supplies", "office"] },
  { pattern: /payroll|salary|wages/i, categoryNameHints: ["payroll", "wages", "salaries"] },
  { pattern: /rent\b/i, categoryNameHints: ["rent", "rent expense"] },
  { pattern: /software|saas|subscription/i, categoryNameHints: ["software", "subscriptions"] },
  { pattern: /travel|airline|hotel|uber|lyft/i, categoryNameHints: ["travel", "travel expense"] },
  { pattern: /transfer/i, categoryNameHints: ["transfer", "transfers"] },
  { pattern: /fee|charge|bank/i, categoryNameHints: ["bank fees", "fees"] },
  { pattern: /payment.*credit card/i, categoryNameHints: ["credit card", "payment"] },
  { pattern: /transfer.*credit/i, categoryNameHints: ["transfer", "interest income"] },
];

export async function categorizeWithLocalRules(clientId: string | null): Promise<{ categorized: number; skipped: number }> {
  const supabase = supabaseAdmin();

  let query = supabase
    .from("transactions")
    .select("id, merchant_name, raw_plaid_category")
    .eq("status", "pending_review")
    .is("ai_category_id", null);

  if (clientId) {
    query = query.eq("client_id", clientId);
  }

  const { data: pending, error } = await query;
  if (error) throw error;
  if (!pending?.length) return { categorized: 0, skipped: 0 };

  let categoriesQuery = supabase.from("categories").select("id, name");
  if (clientId) {
    categoriesQuery = categoriesQuery.or(`client_id.eq.${clientId},is_default.eq.true`);
  }

  const { data: categories } = await categoriesQuery;
  if (!categories?.length) return { categorized: 0, skipped: pending.length };

  let categorized = 0;
  let skipped = 0;

  for (const txn of pending) {
    const searchText = `${txn.merchant_name ?? ""} ${txn.raw_plaid_category ?? ""}`;
    let matchedCategoryId: string | null = null;

    for (const rule of LOCAL_KEYWORD_RULES) {
      if (!rule.pattern.test(searchText)) continue;
      const hit = categories.find((c) =>
        rule.categoryNameHints.some((hint) =>
          c.name.toLowerCase().includes(hint.toLowerCase())
        )
      );
      if (hit) {
        matchedCategoryId = hit.id;
        break;
      }
    }

    if (matchedCategoryId) {
      await supabase
        .from("transactions")
        .update({ ai_category_id: matchedCategoryId, ai_confidence: 1.0 })
        .eq("id", txn.id);
      categorized++;
    } else {
      skipped++;
    }
  }

  console.log(`[categorize-local] client ${clientId ?? "all"}: categorized=${categorized}, skipped=${skipped}`);
  return { categorized, skipped };
}

// ============================================================
// HELPER UTILITIES FOR MERCHANT SANITIZATION & DIRECT RULES
// ============================================================

export function sanitizeMerchantName(rawName: string): string {
  if (!rawName) return '';
  return rawName
    .toLowerCase()
    .replace(/[0-9*#\-]/g, ' ')
    .replace(/\b(inc|llc|co|corp|ltd|store|pvt)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function saveCategoryRule(
  clientId: string,
  merchantName: string,
  categoryId: string,
  confidenceScore = 1.0
) {
  const supabase = supabaseAdmin();
  const pattern = sanitizeMerchantName(merchantName);

  if (!pattern) throw new Error("Invalid merchant pattern");

  const { data, error } = await supabase
    .from("category_mapping_rules")
    .upsert(
      {
        client_id: clientId,
        merchant_pattern: pattern,
        category_id: categoryId,
        confidence_score: confidenceScore,
      },
      { onConflict: "client_id,merchant_pattern" }
    )
    .select();

  if (error) throw error;
  return data;
}