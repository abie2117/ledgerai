// lib/auth-server.ts
// Resolves the logged-in user from the Supabase auth cookie on the
// incoming request. Every API route that touches client data should call
// this first and reject with 401 before doing anything else.

import { NextRequest } from "next/server";
import { createRouteHandlerClient } from "@supabase/auth-helpers-nextjs";
import { cookies } from "next/headers";

export async function getServerUser(_req: NextRequest) {
  const supabase = createRouteHandlerClient({ cookies });
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
