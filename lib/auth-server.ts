// lib/auth-server.ts
// Resolves the logged-in user from the Supabase auth cookie on the
// incoming request. Every API route that touches client data should call
// this first and reject with 401 before doing anything else.

import { NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function getServerUser(_req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    return null; // Safe fallback during build prerendering
  }

  const cookieStore = cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
