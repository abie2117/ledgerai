'use client';
import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserSupabaseClient } from '../../lib/supabase-browser';

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    const supabase = createBrowserSupabaseClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    if (signInError) {
      setError("Couldn't log in — check your email and password.");
      setSubmitting(false);
      return;
    }

    router.refresh();
    router.push(searchParams.get('redirectedFrom') || '/');
  }

  return (
    <div style={{ maxWidth: 400, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ marginBottom: 24 }}>LedgerAI — Log in</h1>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
            style={{ padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14 }} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
            style={{ padding: '10px 12px', border: '1px solid #cbd5e1', borderRadius: 4, fontSize: 14 }} />
        </label>
        {error && <div style={{ color: '#dc2626', fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting}
          style={{ padding: '12px 0', borderRadius: 4, border: 'none', background: '#16a34a', color: 'white', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <div style={{ marginTop: 20, fontSize: 13, color: '#64748b' }}>
        No account? <a href="/signup" style={{ color: '#16a34a' }}>Sign up</a>
      </div>
    </div>
  );
}
