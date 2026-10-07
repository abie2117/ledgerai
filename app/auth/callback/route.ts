import { createServerClient } from '@supabase/ssr';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);

  const code = requestUrl.searchParams.get('code');
  const next = requestUrl.searchParams.get('next') || '/dashboard';

  if (!code) {
    console.error('❌ Supabase callback: missing code');

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

  const {
    data,
    error,
  } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error(
      '❌ Supabase auth callback error:',
      error
    );

    return NextResponse.redirect(
      new URL(
        `/login?error=${encodeURIComponent(error.message)}`,
        request.url
      )
    );
  }

  console.log(
    '✅ Supabase session created:',
    data.session?.user?.id
  );

  return response;
}
