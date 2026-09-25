'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase-browser';
import { getSafeInternalRedirect } from '@/lib/auth-redirect';

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://ledgerai-tawny.vercel.app';

export default function LoginPage() {
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [isRecovery, setIsRecovery] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(() =>
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get(
      'passwordReset',
    ) === 'success'
      ? 'Your password has been updated. You can now log in.'
      : null,
  );
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      if (isRecovery) {
        const redirectUrl = `${SITE_URL}/auth/callback?next=/reset-password`;

        const { error } =
          await supabase.auth.resetPasswordForEmail(
            email.trim(),
            { redirectTo: redirectUrl },
          );

        if (error) {
          setErrorMsg(
            'We could not send the reset email. Please try again.',
          );
          return;
        }

        setSuccessMsg(
          'If an account matches that email, you will receive a password reset link shortly.',
        );
        return;
      }

      /*
       * SIGN UP
       */
      if (isSignUp) {
        const redirectUrl = `${SITE_URL}/auth/callback`;

        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: redirectUrl,
          },
        });

        if (error) {
          setErrorMsg(error.message);
          return;
        }

        /*
         * If Supabase immediately created a session,
         * send the user directly to the dashboard.
         */
        if (data.session) {
          router.push('/dashboard');
          return;
        }

        /*
         * Normal behavior when email confirmation is enabled:
         * user exists, but session is null until email is confirmed.
         */
        setSuccessMsg(
          'Account created successfully! Check your email and click the confirmation link to activate your account.'
        );

        setIsSignUp(false);
        return;
      }

      /*
       * LOGIN
       */
      const { data, error } =
        await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });

      if (error) {
        setErrorMsg(error.message);
        return;
      }

      if (!data.session) {
        setErrorMsg(
          'Login succeeded, but Supabase did not create a session.'
        );

        return;
      }

      const redirectedFrom = new URLSearchParams(
        window.location.search,
      ).get('redirectedFrom');

      router.push(getSafeInternalRedirect(redirectedFrom));
    } catch {
      setErrorMsg(
        'Something went wrong while authenticating. Please try again.'
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        backgroundColor: '#070b14',
        padding: '24px',
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#f8fafc',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          backgroundColor: '#0f172a',
          borderRadius: 16,
          border:
            '1px solid rgba(255,255,255,0.08)',
          boxShadow:
            '0 12px 32px rgba(0,0,0,0.5)',
          padding: '40px 32px',
        }}
      >
        <div
          style={{
            textAlign: 'center',
            marginBottom: 32,
          }}
        >
          <div
            style={{
              width: 50,
              height: 50,
              borderRadius: 14,
              background:
                'linear-gradient(135deg,#0b1329 0%,#030712 100%)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow:
                '0 0 22px rgba(56,189,248,0.4), inset 0 0 10px rgba(129,140,248,0.2)',
              border:
                '1.5px solid rgba(56,189,248,0.6)',
              marginBottom: 16,
            }}
          >
            <svg
              width="28"
              height="28"
              viewBox="0 0 32 32"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <defs>
                <linearGradient
                  id="neon-glow-auth"
                  x1="0"
                  y1="0"
                  x2="32"
                  y2="32"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#38bdf8" />
                  <stop
                    offset="0.5"
                    stopColor="#818cf8"
                  />
                  <stop
                    offset="1"
                    stopColor="#c084fc"
                  />
                </linearGradient>
              </defs>

              <path
                d="M16 3L28 9.5V22.5L16 29L4 22.5V9.5L16 3Z"
                stroke="url(#neon-glow-auth)"
                strokeWidth="2"
                strokeLinejoin="round"
              />

              <circle
                cx="16"
                cy="16"
                r="3"
                fill="#818cf8"
              />
            </svg>
          </div>

          <h1
            style={{
              fontSize: 24,
              fontWeight: 800,
              color: '#ffffff',
              margin: 0,
              letterSpacing: '-0.03em',
            }}
          >
            Ledger
            <span style={{ color: '#38bdf8' }}>
              AI
            </span>
          </h1>

          <p
            style={{
              fontSize: 13,
              color: '#94a3b8',
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            {isRecovery
              ? 'Request a password reset'
              : isSignUp
              ? 'Create your account'
              : 'Log in to your workspace'}
          </p>
        </div>

        {errorMsg && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor:
                'rgba(248,113,113,0.1)',
              border:
                '1px solid rgba(248,113,113,0.3)',
              borderRadius: 8,
              color: '#f87171',
              fontSize: 13,
              marginBottom: 20,
              fontWeight: 500,
            }}
          >
            {errorMsg}
          </div>
        )}

        {successMsg && (
          <div
            style={{
              padding: '12px 16px',
              backgroundColor:
                'rgba(74,222,128,0.1)',
              border:
                '1px solid rgba(74,222,128,0.3)',
              borderRadius: 8,
              color: '#4ade80',
              fontSize: 13,
              marginBottom: 20,
              fontWeight: 500,
            }}
          >
            {successMsg}
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#94a3b8',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Email Address
            </label>

            <input
              type="email"
              required
              value={email}
              onChange={(e) =>
                setEmail(e.target.value)
              }
              placeholder="name@example.com"
              autoComplete="email"
              style={{
                width: '100%',
                padding: '11px 14px',
                borderRadius: 8,
                border:
                  '1px solid rgba(255,255,255,0.1)',
                backgroundColor: '#1e293b',
                color: '#fff',
                fontSize: 14,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {!isRecovery && (
            <div>
              <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#94a3b8',
                marginBottom: 6,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Password
            </label>

              <div
                style={{
                  position: 'relative',
                }}
              >
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) =>
                    setPassword(e.target.value)
                  }
                  placeholder="••••••••"
                  autoComplete={
                    isSignUp
                      ? 'new-password'
                      : 'current-password'
                  }
                  style={{
                    width: '100%',
                    padding: '11px 44px 11px 14px',
                    borderRadius: 8,
                    border:
                      '1px solid rgba(255,255,255,0.1)',
                    backgroundColor: '#1e293b',
                    color: '#fff',
                    fontSize: 14,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />

                <button
                  type="button"
                  onClick={() =>
                    setShowPassword((visible) => !visible)
                  }
                  aria-label={
                    showPassword
                      ? 'Hide password'
                      : 'Show password'
                  }
                  style={{
                    position: 'absolute',
                    top: '50%',
                    right: 10,
                    transform: 'translateY(-50%)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 28,
                    height: 28,
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: '#94a3b8',
                    cursor: 'pointer',
                  }}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {showPassword ? (
                      <>
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                        <circle cx="12" cy="12" r="3" />
                      </>
                    ) : (
                      <>
                        <path d="m3 3 18 18" />
                        <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18.3 18.3 0 0 1-3.1 3.9" />
                        <path d="M6.7 6.7C3.7 8.6 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 3.3-.6" />
                        <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
                      </>
                    )}
                  </svg>
                </button>
              </div>

              {!isSignUp && (
                <button
                  type="button"
                  onClick={() => {
                    setIsRecovery(true);
                    setErrorMsg(null);
                    setSuccessMsg(null);
                    setPassword('');
                    setShowPassword(false);
                  }}
                  style={{
                    marginTop: 8,
                    padding: 0,
                    border: 'none',
                    background: 'none',
                    color: '#38bdf8',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Forgot password?
                </button>
              )}
              </div>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 8,
              width: '100%',
              padding: '12px',
              backgroundColor:
                loading
                  ? '#334155'
                  : '#0284c7',
              color: '#ffffff',
              borderRadius: 8,
              border: 'none',
              fontWeight: 600,
              fontSize: 14,
              cursor: loading
                ? 'not-allowed'
                : 'pointer',
              boxShadow:
                '0 4px 14px rgba(2,132,199,0.3)',
              transition:
                'background-color 0.2s',
            }}
          >
            {loading
              ? 'Processing...'
              : isRecovery
                ? 'Send reset link'
              : isSignUp
                ? 'Create Account'
                : 'Log In'}
          </button>
        </form>

        <div
          style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 13,
            color: '#94a3b8',
          }}
        >
          {isRecovery
            ? 'Remember your password?'
            : isSignUp
            ? 'Already have an account?'
            : "Don't have an account?"}{' '}

          <button
            type="button"
            onClick={() => {
              setIsRecovery(false);
              setIsSignUp(
                isRecovery ? false : !isSignUp,
              );
              setErrorMsg(null);
              setSuccessMsg(null);
              setPassword('');
              setShowPassword(false);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#38bdf8',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: 13,
              padding: 0,
            }}
          >
            {isRecovery
              ? 'Log in'
              : isSignUp
              ? 'Log in'
              : 'Sign up'}
          </button>
        </div>
      </div>
    </div>
  );
}
