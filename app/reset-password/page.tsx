'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase-browser';

function PasswordField({
  id,
  label,
  value,
  autoComplete,
  onChange,
  show,
  onToggle,
}: {
  id: string;
  label: string;
  value: string;
  autoComplete: string;
  onChange: (value: string) => void;
  show: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      <label
        htmlFor={id}
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
        {label}
      </label>

      <div style={{ position: 'relative' }}>
        <input
          id={id}
          type={show ? 'text' : 'password'}
          required
          minLength={6}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete={autoComplete}
          style={{
            width: '100%',
            padding: '11px 44px 11px 14px',
            borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.1)',
            backgroundColor: '#1e293b',
            color: '#fff',
            fontSize: 14,
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        <button
          type="button"
          onClick={onToggle}
          aria-label={show ? 'Hide password' : 'Show password'}
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
            {show ? (
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
    </div>
  );
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [hasSession, setHasSession] = useState(false);

  useEffect(() => {
    async function verifySession() {
      const { data, error } = await supabase.auth.getUser();

      if (error || !data.user) {
        setErrorMsg(
          'This password reset link is invalid or has expired.',
        );
      } else {
        setHasSession(true);
      }

      setLoading(false);
    }

    void verifySession();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (newPassword.length < 6) {
      setErrorMsg('Your password must be at least 6 characters.');
      return;
    }

    if (newPassword !== confirmPassword) {
      setErrorMsg('The passwords do not match.');
      return;
    }

    setSubmitting(true);

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setErrorMsg(
          'We could not update your password. Please request a new reset link and try again.',
        );
        return;
      }

      setSuccessMsg(
        'Your password has been updated. Redirecting to login...',
      );

      window.setTimeout(() => {
        router.push('/login?passwordReset=success');
      }, 700);
    } catch {
      setErrorMsg(
        'We could not update your password. Please request a new reset link and try again.',
      );
    } finally {
      setSubmitting(false);
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
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
          padding: '40px 32px',
        }}
      >
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 800,
              color: '#ffffff',
              margin: 0,
              letterSpacing: '-0.03em',
            }}
          >
            Ledger<span style={{ color: '#38bdf8' }}>AI</span>
          </h1>

          <p
            style={{
              fontSize: 13,
              color: '#94a3b8',
              marginTop: 6,
              marginBottom: 0,
            }}
          >
            Set a new password
          </p>
        </div>

        {errorMsg && (
          <div
            role="alert"
            style={{
              padding: '12px 16px',
              backgroundColor: 'rgba(248,113,113,0.1)',
              border: '1px solid rgba(248,113,113,0.3)',
              borderRadius: 8,
              color: '#f87171',
              fontSize: 13,
              marginBottom: 20,
              fontWeight: 500,
            }}
          >
            {errorMsg}{' '}
            {!hasSession && (
              <a href="/login" style={{ color: '#38bdf8' }}>
                Request another reset link.
              </a>
            )}
          </div>
        )}

        {successMsg && (
          <div
            role="status"
            style={{
              padding: '12px 16px',
              backgroundColor: 'rgba(74,222,128,0.1)',
              border: '1px solid rgba(74,222,128,0.3)',
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

        {hasSession && (
          <form
            onSubmit={handleSubmit}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 18,
            }}
          >
            <PasswordField
              id="new-password"
              label="New password"
              value={newPassword}
              autoComplete="new-password"
              onChange={setNewPassword}
              show={showNewPassword}
              onToggle={() => setShowNewPassword((show) => !show)}
            />

            <PasswordField
              id="confirm-password"
              label="Confirm new password"
              value={confirmPassword}
              autoComplete="new-password"
              onChange={setConfirmPassword}
              show={showConfirmPassword}
              onToggle={() =>
                setShowConfirmPassword((show) => !show)
              }
            />

            <button
              type="submit"
              disabled={submitting || loading}
              style={{
                marginTop: 8,
                width: '100%',
                padding: '12px',
                backgroundColor: submitting ? '#334155' : '#0284c7',
                color: '#ffffff',
                borderRadius: 8,
                border: 'none',
                fontWeight: 600,
                fontSize: 14,
                cursor: submitting ? 'not-allowed' : 'pointer',
                boxShadow: '0 4px 14px rgba(2,132,199,0.3)',
              }}
            >
              {submitting ? 'Updating...' : 'Update password'}
            </button>
          </form>
        )}

        <div
          style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 13,
            color: '#94a3b8',
          }}
        >
          <a href="/login" style={{ color: '#38bdf8' }}>
            Back to login
          </a>
        </div>
      </div>
    </div>
  );
}