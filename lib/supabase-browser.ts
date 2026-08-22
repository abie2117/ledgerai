// lib/supabase-browser.ts
// Uses @supabase/ssr for correct cookie handling in Next.js 14 App Router.
// This replaces the @supabase/auth-helpers-nextjs client-side client.

import { createBrowserClient } from "@supabase/ssr";

export function createBrowserSupabaseClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
