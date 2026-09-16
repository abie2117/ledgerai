'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';

interface PlaidLinkButtonProps {
  selectedClientId?: string;
  onBankConnected?: () => void;
}

export default function PlaidLinkButton({
  selectedClientId,
  onBankConnected,
}: PlaidLinkButtonProps) {
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);
  const [isExchanging, setIsExchanging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!selectedClientId) {
      setToken(null);
      setLoadingToken(false);
      setErrorMessage(null);

      return () => {
        mounted = false;
      };
    }

    async function fetchLinkToken() {
      try {
        setToken(null);
        setLoadingToken(true);
        setErrorMessage(null);

        console.log(
          '🔐 Requesting Plaid Link token for client:',
          selectedClientId
        );

        const res = await fetch('/api/plaid/create-link-token', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: selectedClientId,
          }),
        });

        const data = await res.json();

        console.log('📦 Plaid Link token response:', data);

        if (!res.ok) {
          console.error(
            '❌ Plaid link token request failed:',
            data
          );

          if (mounted) {
            setErrorMessage(
              data?.error ||
                'Unable to initialize bank connection.'
            );
          }

          return;
        }

        if (!data.link_token) {
          console.error(
            '❌ Plaid response did not contain a link_token:',
            data
          );

          if (mounted) {
            setErrorMessage(
              'Plaid did not return a valid Link token.'
            );
          }

          return;
        }

        if (mounted) {
          setToken(data.link_token);

          console.log(
            '✅ Plaid Link token created for client:',
            selectedClientId
          );
        }
      } catch (error) {
        console.error(
          '❌ Failed to fetch Plaid link token:',
          error
        );

        if (mounted) {
          setErrorMessage(
            'Unable to connect to Plaid. Please try again.'
          );
        }
      } finally {
        if (mounted) {
          setLoadingToken(false);
        }
      }
    }

    fetchLinkToken();

    return () => {
      mounted = false;
    };
  }, [selectedClientId]);

  const onSuccess = useCallback(
    async (publicToken: string) => {
      try {
        setIsExchanging(true);
        setErrorMessage(null);

        console.log('🏦 Plaid bank selected successfully');
        console.log('🔄 Exchanging Plaid public token...');

        if (!selectedClientId) {
          console.error(
            '❌ No LedgerAI client ID was provided.'
          );

          setErrorMessage(
            'Please select a LedgerAI client before connecting a bank account.'
          );

          return;
        }

        console.log(
          '🏢 Connecting bank to LedgerAI client:',
          selectedClientId
        );

        const res = await fetch('/api/plaid/exchange', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            public_token: publicToken,
            client_id: selectedClientId,
          }),
        });

        const data = await res.json();

        console.log('📦 Plaid exchange response:', data);

        if (!res.ok) {
          console.error(
            '❌ Plaid token exchange failed:',
            data
          );

          setErrorMessage(
            data?.error ||
              'Unable to connect your bank account.'
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
      } catch (error) {
        console.error(
          '❌ Error exchanging Plaid public token:',
          error
        );

        setErrorMessage(
          'Something went wrong while connecting your bank.'
        );
      } finally {
        setIsExchanging(false);
      }
    },
    [selectedClientId, onBankConnected]
  );

  const { open, ready } = usePlaidLink({
    token,
    onSuccess,
  });

  const isReady =
    ready &&
    !!token &&
    !!selectedClientId &&
    !loadingToken &&
    !isExchanging;

  function handleOpen() {
    if (!selectedClientId) {
      setErrorMessage(
        'Please select a LedgerAI client before connecting a bank account.'
      );
      return;
    }

    if (!token) {
      console.error(
        '❌ Cannot open Plaid because there is no Link token.'
      );

      setErrorMessage(
        'Plaid is not ready yet. Please try again.'
      );

      return;
    }

    if (!ready) {
      console.error(
        '❌ Plaid Link is not ready yet.'
      );

      setErrorMessage(
        'Plaid is still loading. Please try again in a moment.'
      );

      return;
    }

    console.log('🚀 Opening Plaid Link...');

    open();
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleOpen}
        disabled={!isReady}
        className={
          isReady
            ? 'px-4 py-2 rounded text-white font-semibold bg-blue-600 hover:bg-blue-700 cursor-pointer'
            : 'px-4 py-2 rounded text-white font-semibold bg-gray-400 cursor-not-allowed'
        }
      >
        {isExchanging
          ? 'Syncing bank data...'
          : loadingToken
          ? 'Initializing Plaid...'
          : isReady
          ? 'Connect bank account'
          : 'Plaid Unavailable'}
      </button>

      {errorMessage && (
        <div
          style={{
            marginTop: 8,
            color: '#f87171',
            fontSize: 13,
          }}
        >
          {errorMessage}
        </div>
      )}
    </div>
  );
}