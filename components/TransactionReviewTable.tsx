import React from 'react';

export interface Transaction {
  transaction_id: string;
  name: string;
  amount: number;
  posted_date?: string;
  category: string[];
  ai_category: string | null;
  confidence_score: number | null;
}

interface TransactionReviewTableProps {
  transactions: Transaction[];
}

export default function TransactionReviewTable({ transactions }: TransactionReviewTableProps) {
  if (!transactions || transactions.length === 0) {
    return (
      <div className="p-6 text-center text-gray-500 bg-white rounded-lg border border-gray-200">
        No transactions synced yet. Connect a bank account to get started.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 shadow-sm bg-white">
      <table className="min-w-full divide-y divide-gray-200 text-left text-sm">
        <thead className="bg-gray-50 font-semibold text-gray-700">
          <tr>
            <th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Description</th>
            <th className="px-4 py-3">AI Category</th>
            <th className="px-4 py-3 text-right">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 text-gray-900">
          {transactions.map((tx) => (
            <tr key={tx.transaction_id} className="hover:bg-gray-50 transition-colors">
              <td className="px-4 py-3 text-gray-600 whitespace-nowrap font-medium">
                {tx.posted_date || 'N/A'}
              </td>
              <td className="px-4 py-3">
                <div className="font-semibold text-gray-900">{tx.name}</div>
                {tx.category && tx.category.length > 0 && (
                  <div className="text-xs text-gray-500 mt-0.5">
                    {tx.category.join(', ')}
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-800">
                    {tx.ai_category || 'Uncategorized'}
                  </span>
                  {tx.confidence_score !== null && tx.confidence_score !== undefined && (
                    <span className="inline-flex items-center rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 ring-1 ring-inset ring-blue-700/10">
                      {Math.round(tx.confidence_score * 100)}%
                    </span>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-right font-semibold whitespace-nowrap">
                ${tx.amount.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}