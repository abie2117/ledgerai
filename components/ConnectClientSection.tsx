'use client';

import React, { useState } from 'react';

interface ConnectClientSectionProps {
  clientId?: string;
}

export default function ConnectClientSection({ clientId }: ConnectClientSectionProps) {
  const [isLoading, setIsLoading] = useState(false);

  const handleLocalCategorize = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/categorize-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      });

      if (!response.ok) {
        throw new Error('Failed to run local categorization');
      }

      // Reload page to refresh table data
      window.location.reload();
    } catch (error) {
      console.error('Categorization error:', error);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3 p-4 bg-white rounded-lg border border-gray-200 shadow-sm">
      <button
        onClick={handleLocalCategorize}
        disabled={isLoading}
        className="px-3 py-1.5 text-xs font-medium bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 border border-gray-300 disabled:opacity-50 transition-colors"
      >
        {isLoading ? 'Categorizing...' : 'Categorize (free/local)'}
      </button>
    </div>
  );
}