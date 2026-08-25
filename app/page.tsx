'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import PlaidLinkButton from '../components/PlaidLinkButton';

interface Transaction {
  id: string;
  merchant_name: string;
  amount: number;
  status?: string;
  category?: string;
  raw_plaid_category?: string;
  client_name?: string;
}

export default function DashboardPage() {
  const router = useRouter();
  const [selectedClient, setSelectedClient] = useState('Acme Corp');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [categorizing, setCategorizing] = useState(false);

  const loadTransactions = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/plaid/transactions?t=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ client_name: selectedClient }),
      });
      const data = await res.json();
      setTransactions(data.transactions || []);
      router.refresh();
    } catch (err) {
      console.error('Failed to load transactions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTransactions();
  }, [selectedClient]);

  const handleCategorizeLocal = async () => {
    try {
      setCategorizing(true);
      const res = await fetch('/api/categorize-local', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ client_name: selectedClient }),
      });

      if (!res.ok) {
        throw new Error('Failed to run local categorization');
      }

      await loadTransactions();
    } catch (err) {
      console.error('Categorization error:', err);
    } finally {
      setCategorizing(false);
    }
  };

  return (
    <main className="p-8 max-w-5xl mx-auto font-sans">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold">LedgerAI Dashboard</h1>
          <p className="text-sm text-gray-500">
            Active Client:{' '}
            <span className="font-semibold text-blue-600">{selectedClient}</span>
          </p>
        </div>

        <select
          value={selectedClient}
          onChange={(e) => setSelectedClient(e.target.value)}
          className="p-2 border border-gray-300 rounded shadow-sm bg-white font-medium text-gray-800"
        >
          <option value="Acme Corp">Acme Corp</option>
          <option value="Stark Industries">Stark Industries</option>
          <option value="Wayne Enterprises">Wayne Enterprises</option>
        </select>
      </div>

      <div className="flex gap-4 mb-8">
        <PlaidLinkButton 
          selectedClient={selectedClient} 
          onBankConnected={loadTransactions} 
        />
        <button
          onClick={handleCategorizeLocal}
          disabled={categorizing}
          className={`px-4 py-2 text-white rounded font-semibold transition ${
            categorizing 
              ? 'bg-emerald-400 cursor-not-allowed' 
              : 'bg-emerald-600 hover:bg-emerald-700 cursor-pointer'
          }`}
        >
          {categorizing ? 'Categorizing...' : 'Categorize (free/local)'}
        </button>
      </div>

      <div className="border border-gray-200 rounded-lg p-4 bg-white shadow-sm">
        <h2 className="text-xl font-bold mb-4">Transactions for {selectedClient}</h2>

        {loading ? (
          <p className="text-gray-500">Loading transactions for {selectedClient}...</p>
        ) : transactions.length > 0 ? (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="p-3">Merchant</th>
                <th className="p-3">Amount</th>
                <th className="p-3">Category</th>
                <th className="p-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id} className="border-b border-gray-100">
                  <td className="p-3 font-medium">{tx.merchant_name || 'Unknown'}</td>
                  <td className="p-3">${Number(tx.amount).toFixed(2)}</td>
                  <td className="p-3 text-sm text-gray-600">
                    {tx.category || tx.raw_plaid_category || 'Uncategorized'}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-1 rounded text-xs font-bold ${
                        tx.status === 'confirmed'
                          ? 'bg-green-100 text-green-800'
                          : 'bg-yellow-100 text-yellow-800'
                      }`}
                    >
                      {tx.status || 'pending_review'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-gray-600">
            No transactions synced yet for {selectedClient}. Connect a bank account or sync to get started.
          </p>
        )}
      </div>
    </main>
  );
}