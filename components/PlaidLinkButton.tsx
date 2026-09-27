'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePlaidLink } from 'react-plaid-link';

interface PlaidLinkButtonProps {
  selectedClientId?: string;
  onBankConnected?: () => void;
  reconnectItemId?: string;
  reconnectClientRef?: string;
  reconnectConnectionRef?: string;
  onReconnected?: () => void | Promise<void>;
  reconnectLabel?: string;
}

export default function PlaidLinkButton({
  selectedClientId,
  onBankConnected,
  reconnectItemId,
  reconnectClientRef,
  reconnectConnectionRef,
  onReconnected,
  reconnectLabel,
}: PlaidLinkButtonProps) {
  const [token, setToken] = useState<string | null>(null);
  const [loadingToken, setLoadingToken] = useState(false);
  const [isExchanging, setIsExchanging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isOpaqueReconnect = Boolean(reconnectClientRef && reconnectConnectionRef);
  const isLegacyReconnect = Boolean(reconnectItemId);
  const isReconnect = isOpaqueReconnect || isLegacyReconnect;

  const fetchLinkToken = useCallback(async () => {
    try {
      setToken(null);
      setLoadingToken(true);
      setErrorMessage(null);

      const endpoint = isReconnect
        ? '/api/plaid/reconnect-link-token'
        : '/api/plaid/create-link-token';
      const requestBody = isOpaqueReconnect
        ? { clientRef: reconnectClientRef, connectionRef: reconnectConnectionRef }
        : isLegacyReconnect
          ? { plaid_item_database_id: reconnectItemId }
          : { client_id: selectedClientId };

      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.link_token) {
        throw new Error(data?.error || 'Unable to initialize bank connection.');
      }

      setToken(data.link_token);
    } catch (error) {
      console.error('Failed to fetch Plaid Link token:', error);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : 'Unable to connect to Plaid. Please try again.',
      );
    } finally {
      setLoadingToken(false);
    }
  }, [
    isReconnect,
    isOpaqueReconnect,
    isLegacyReconnect,
    reconnectClientRef,
    reconnectConnectionRef,
    reconnectItemId,
    selectedClientId,
  ]);

  useEffect(() => {
    if (isOpaqueReconnect) {
      setToken(null);
      setErrorMessage(null);
      return;
    }

    if (!selectedClientId) {
      setToken(null);
      setErrorMessage(null);
      return;
    }

    void fetchLinkToken();
  }, [selectedClientId, isOpaqueReconnect, fetchLinkToken]);

  const onSuccess = useCallback(
    async (_publicToken: string) => {
      try {
        setIsExchanging(true);
        setErrorMessage(null);

        if (isReconnect) {
          const requestBody = isOpaqueReconnect
            ? { clientRef: reconnectClientRef, connectionRef: reconnectConnectionRef }
            : { plaid_item_database_id: reconnectItemId };
          const completeResponse = await fetch('/api/plaid/reconnect/complete', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          });
          const completeResult = await completeResponse.json().catch(() => null);

          if (!completeResponse.ok || !completeResult?.success) {
            throw new Error(
              completeResult?.error || 'Unable to complete bank reconnection.',
            );
          }

          setToken(null);
          await onReconnected?.();
          return;
        }

        if (!selectedClientId) {
          throw new Error('Please select a LedgerAI client before connecting a bank account.');
        }

        const res = await fetch('/api/plaid/exchange', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            public_token: _publicToken,
            client_id: selectedClientId,
          }),
        });
        const data = await res.json().catch(() => null);

        if (!res.ok) {
          throw new Error(data?.error || 'Unable to connect your bank account.');
        }

        onBankConnected?.();
      } catch (error) {
        console.error('Plaid connection failed:', error);
        setErrorMessage(
          error instanceof Error
            ? error.message
            : 'Something went wrong while connecting your bank.',
        );
      } finally {
        setIsExchanging(false);
      }
    },
    [
      isReconnect,
      isOpaqueReconnect,
      reconnectClientRef,
      reconnectConnectionRef,
      reconnectItemId,
      selectedClientId,
      onBankConnected,
      onReconnected,
    ],
  );

  const onExit = useCallback(() => {
    if (isOpaqueReconnect) {
      setToken(null);
    }
  }, [isOpaqueReconnect]);

  const { open, ready } = usePlaidLink({ token, onSuccess, onExit });

  useEffect(() => {
    if (isOpaqueReconnect && token && ready && !isExchanging) {
      open();
    }
  }, [isOpaqueReconnect, token, ready, isExchanging, open]);

  const canRequestOpaqueReconnect =
    isOpaqueReconnect && !loadingToken && !isExchanging && !token;
  const isReady =
    ready &&
    !!token &&
    (!!selectedClientId || isReconnect) &&
    !loadingToken &&
    !isExchanging;

  function handleOpen() {
    if (canRequestOpaqueReconnect) {
      void fetchLinkToken();
      return;
    }

    if (!selectedClientId && !isReconnect) {
      setErrorMessage('Please select a LedgerAI client before connecting a bank account.');
      return;
    }

    if (!token || !ready) {
      setErrorMessage('Plaid is not ready yet. Please try again in a moment.');
      return;
    }

    open();
  }

  const buttonEnabled = isOpaqueReconnect
    ? canRequestOpaqueReconnect || isReady
    : isReady;

  return (
    <div>
      <button
        type="button"
        onClick={handleOpen}
        disabled={!buttonEnabled}
        className={
          buttonEnabled
            ? 'px-4 py-2 rounded text-white font-semibold bg-blue-600 hover:bg-blue-700 cursor-pointer'
            : 'px-4 py-2 rounded text-white font-semibold bg-gray-400 cursor-not-allowed'
        }
      >
        {isExchanging
          ? 'Finishing reconnection...'
          : loadingToken
            ? 'Initializing Plaid...'
            : isReconnect
              ? reconnectLabel || 'Fix connection'
              : isReady
                ? 'Connect bank account'
                : 'Plaid Unavailable'}
      </button>

      {errorMessage && (
        <div style={{ marginTop: 8, color: '#f87171', fontSize: 13 }}>
          {errorMessage}
        </div>
      )}
    </div>
  );
}
