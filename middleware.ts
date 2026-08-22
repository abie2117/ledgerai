import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name) { return req.cookies.get(name)?.value; },
        set(name, value, options) { res.cookies.set({ name, value, ...options }); },
        remove(name, options) { res.cookies.set({ name, value: "", ...options }); },
      },
    }
  );

  const { data: { session } } = await supabase.auth.getSession();
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