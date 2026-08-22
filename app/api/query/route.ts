// app/api/query/route.ts
// Natural Language Query engine:
// 1. Receives plain English question + clientId
// 2. Claude converts it to safe SQL
// 3. Supabase runs the SQL
// 4. Results returned to the UI

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { createRouteHandlerClient } from '@/lib/supabase-server';

function serviceRole() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function buildSystemPrompt(clientId: string): string {
  return `You are a financial data analyst for LedgerAI. Convert the user's plain English question into a valid PostgreSQL SELECT query.

Schema:
Table: transactions
  id (uuid), client_id (uuid), posted_date (date), amount (numeric),
  merchant_name (text), raw_plaid_category (text), ai_category_id (uuid), status (text)

Table: categories
  id (uuid), name (text), coa_code (text)

Rules:
- ALWAYS include WHERE client_id = '${clientId}' in every query
- Only write SELECT statements. Never INSERT, UPDATE, DELETE, DROP, or any mutation
- Join categories using: LEFT JOIN categories c ON t.ai_category_id = c.id
- Always alias transactions as t and categories as c
- For date filtering use posted_date (type: date)
- For "last month" use: date_trunc('month', current_date - interval '1 month')
- For "this month" use: date_trunc('month', current_date)
- Return ONLY the raw SQL query — no markdown, no backticks, no explanation
- Limit results to 100 rows maximum`;
}

function isSafeQuery(sql: string, clientId: string): boolean {
  const upper = sql.trim().toUpperCase();
  if (!upper.startsWith('SELECT')) return false;
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE', 'GRANT', 'REVOKE'];
  if (forbidden.some((kw) => upper.includes(kw))) return false;
  if (!sql.includes(clientId)) return false;
  return true;
}

export async function POST(req: Request) {
  const authClient = createRouteHandlerClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { question, clientId } = await req.json();
  if (!question || !clientId) {
    return NextResponse.json({ error: 'question and clientId are required' }, { status: 400 });
  }

  // Step 1: Claude generates SQL with safe error handling for credits/billing
  let sql: string = '';
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 500,
      system: buildSystemPrompt(clientId),
      messages: [{ role: 'user', content: question }],
    });
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No SQL returned');
    sql = textBlock.text.trim();
  } catch (err: any) {
    console.warn('[query] AI service unavailable (Credit/Billing or Network):', err.message);
    
    // Graceful fallback response returning 200 so UI doesn't blow up
    return NextResponse.json({ 
      error: 'AI query is currently inactive due to zero credit balance. Please use the manual filters or fund your Anthropic account.',
      sql: '',
      results: [] 
    }, { status: 200 });
  }

  // Step 2: Safety check before running
  if (!isSafeQuery(sql, clientId)) {
    console.error('[query] Unsafe SQL rejected:', sql);
    return NextResponse.json({ error: 'Generated query failed safety check' }, { status: 400 });
  }

  // Step 3: Run the query
  try {
    const db = serviceRole();
    const { data, error } = await db.rpc('run_safe_query', { query_text: sql });
    if (error) throw error;
    return NextResponse.json({ sql, results: data ?? [] });
  } catch (err: any) {
    console.error('[query] RPC failed, trying direct REST:', err.message);
    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/run_safe_query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY!,
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
        },
        body: JSON.stringify({ query_text: sql }),
      });
      const data = await response.json();
      return NextResponse.json({ sql, results: Array.isArray(data) ? data : [] });
    } catch (fallbackErr: any) {
      return NextResponse.json({ error: fallbackErr.message, sql }, { status: 500 });
    }
  }
}