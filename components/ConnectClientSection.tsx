'use client';

import React, { useState } from 'react';
import { supabase } from '@/lib/supabase-browser';

interface ConnectClientSectionProps {
  clientId?: string;
  onCategorized?: () => void;
}

export default function ConnectClientSection({
  clientId,
  onCategorized,
}: ConnectClientSectionProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handleLocalCategorize = async () => {
    setIsLoading(true);
    setMessage('');
    setError('');

    try {
      // Get the currently signed-in LedgerAI user.
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        throw new Error(
          'You must be signed in to categorize transactions.'
        );
      }

      const resolvedClientId = clientId || user.id;

      console.log(
        '[Categorize] Running local categorization for:',
        resolvedClientId
      );

      const response = await fetch('/api/categorize-local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          clientId: resolvedClientId,
          client_id: resolvedClientId,
          user_id: user.id,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        console.error(
          '[Categorize] API error:',
          data
        );

        throw new Error(
          data?.error ||
            data?.message ||
            'Failed to run local categorization.'
        );
      }

      console.log(
        '[Categorize] Success:',
        data
      );

      setMessage(
        `Categorized ${
          data?.updated ??
          data?.count ??
          data?.categorized ??
          'your'
        } transactions.`
      );

      if (onCategorized) {
        onCategorized();
      } else {
        // Give the user a moment to see the success state,
        // then refresh the dashboard table.
        setTimeout(() => {
          window.location.reload();
        }, 700);
      }
    } catch (err) {
      console.error(
        '[Categorize] Categorization failed:',
        err
      );

      setError(
        err instanceof Error
          ? err.message
          : 'Categorization failed.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-2"
      style={{
        minWidth: 220,
      }}
    >
      <button
        type="button"
        onClick={handleLocalCategorize}
        disabled={isLoading}
        className="px-4 py-2 text-sm font-semibold rounded-lg transition-colors"
        style={{
          backgroundColor: isLoading
            ? '#374151'
            : '#0f172a',
          color: isLoading
            ? '#9ca3af'
            : '#818cf8',
          border:
            '1px solid rgba(129,140,248,0.4)',
          cursor: isLoading
            ? 'not-allowed'
            : 'pointer',
          opacity: isLoading ? 0.7 : 1,
        }}
      >
        {isLoading
          ? 'Categorizing...'
          : 'Categorize (Free/Local)'}
      </button>

      {message && (
        <div
          style={{
            fontSize: 12,
            color: '#4ade80',
          }}
        >
          {message}
        </div>
      )}

      {error && (
        <div
          style={{
            fontSize: 12,
            color: '#f87171',
            maxWidth: 320,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
