import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function proxy(req: NextRequest) {
  let response = NextResponse.next({
    request: {
      headers: req.headers,
    },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },

        setAll(cookiesToSet) {
          cookiesToSet.forEach(
            ({ name, value }) => {
              req.cookies.set(name, value);
            }
          );

          response = NextResponse.next({
            request: {
              headers: req.headers,
            },
          });

          cookiesToSet.forEach(
            ({ name, value, options }) => {
              response.cookies.set(
                name,
                value,
                options
              );
            }
          );
        },
      },
    }
  );


  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();


  if (error) {
    console.error(
      '❌ MIDDLEWARE AUTH ERROR:',
      error
    );
  }

  const protectedPrefixes = [
    '/dashboard',
    '/clients',
  ];

  const isProtected =
    protectedPrefixes.some((prefix) =>
      req.nextUrl.pathname.startsWith(prefix)
    );

  if (isProtected && !user) {

    const redirectUrl = new URL(
      '/login',
      req.url
    );

    redirectUrl.searchParams.set(
      'redirectedFrom',
      req.nextUrl.pathname
    );

    return NextResponse.redirect(
      redirectUrl
    );
  }


  return response;
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/clients/:path*',
  ],
};
