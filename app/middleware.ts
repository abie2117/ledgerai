// middleware.ts
// Gatekeeper for every route under /dashboard and /clients — redirects to
// /login if there's no active Supabase session. This is a UX convenience,
// not the real security boundary: RLS on the database (schema/001_init.sql)
// is what actually prevents unauthorized data access even if this ever
// gets bypassed.

import { createMiddlewareClient } from "@supabase/auth-helpers-nextjs";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createMiddlewareClient({ req, res });
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const protectedPrefixes = ["/dashboard", "/clients"];
  const isProtected = protectedPrefixes.some((p) => req.nextUrl.pathname.startsWith(p));

  if (isProtected && !session) {
    const redirectUrl = new URL("/login", req.url);
    redirectUrl.searchParams.set("redirectedFrom", req.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return res;
}

export const config = {
  matcher: ["/dashboard/:path*", "/clients/:path*"],
};
