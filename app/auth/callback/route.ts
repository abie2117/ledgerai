import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSafeInternalRedirect } from '@/lib/auth-redirect';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get('code');
  const next = getSafeInternalRedirect(
    requestUrl.searchParams.get('next'),
  );

  if (!code) {
    console.error('Supabase callback missing code');

    return NextResponse.redirect(
      new URL('/login?error=missing_code', request.url)
    );
  }

  const response = NextResponse.redirect(
    new URL(next, request.url)
  );

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name) {
          return request.cookies.get(name)?.value;
        },

        set(name, value, options) {
          response.cookies.set({
            name,
            value,
            ...options,
          });
        },

        remove(name, options) {
          response.cookies.set({
            name,
            value: '',
            ...options,
          });
        },
      },
    }
  );

  const { error } =
    await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('Supabase auth callback exchange failed');

    return NextResponse.redirect(
      new URL(
        '/login?error=auth_callback_failed',
        request.url
      )
    );
  }

  return response;
}
