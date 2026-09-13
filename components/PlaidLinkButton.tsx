'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';
import { supabase } from '../lib/supabase-browser';

interface PlaidLinkButtonProps {
  selectedClientId?: string;
  onBankConnected?: () => void;
}

export default function PlaidLinkButton({
  selectedClientId,
  onBankConnected,
}: PlaidLinkButtonProps) {
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(true);
  const [isExchanging, setIsExchanging] = useState(false);
  const [activeUserId, setActiveUserId] = useState<string | null>(null);

  useEffect(() => {
    async function getUser() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (session?.user?.id) {
        setActiveUserId(session.user.id);
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (user?.id) {
        setActiveUserId(user.id);
      }
    }

    getUser();
  }, []);

  useEffect(() => {
    async function fetchLinkToken() {
      try {
        setLoadingToken(true);

        const res = await fetch('/api/plaid/create-link-token', {
          method: 'POST',
          credentials: 'include',
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(
            'Plaid link token request failed:',
            data
          );
          return;
        }

        if (data.link_token) {
          setToken(data.link_token);
        } else {
          console.error(
            'Plaid response did not contain a link_token:',
            data
          );
        }
      } catch (err) {
        console.error(
          'Failed to fetch Plaid link token:',
          err
        );
      } finally {
        setLoadingToken(false);
      }
    }

    fetchLinkToken();
  }, []);

  const onSuccess = useCallback(
    async (public_token: string) => {
      try {
        setIsExchanging(true);

        const targetClientId =
          selectedClientId ||
          '22222222-2222-2222-2222-222222222222';

        const res = await fetch('/api/plaid/exchange', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            public_token,
            client_id: targetClientId,
            user_id: activeUserId,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          console.error(
            'Plaid token exchange failed:',
            data
          );
          return;
        }

        console.log(
          '✅ Plaid bank connection successful:',
          data
        );

        if (onBankConnected) {
          onBankConnected();
        }
      } catch (err) {
        console.error(
          'Error exchanging public token:',
          err
        );
      } finally {
        setIsExchanging(false);
      }
    },
    [
      selectedClientId,
      activeUserId,
      onBankConnected,
    ]
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
  });

  return (
    <button
      onClick={() => open()}
      disabled={
        !ready ||
        loadingToken ||
        isExchanging ||
        !token
      }
      className={`px-4 py-2 rounded text-white font-semibold ${
        ready &&
        !loadingToken &&
        !isExchanging &&
        token
          ? 'bg-blue-600 hover:bg-blue-700 cursor-pointer'
          : 'bg-gray-400 cursor-not-allowed'
      }`}
    >
      {isExchanging
        ? 'Syncing bank data...'
        : loadingToken
        ? 'Initializing Plaid...'
        : ready && token
        ? 'Connect bank account'
        : 'Plaid Unavailable'}
    </button>
  );
}
