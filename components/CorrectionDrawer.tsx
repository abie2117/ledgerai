import React, { useState } from 'react';

interface Category {
  id: string;
  name: string;
  coa_code?: string;
}

interface Transaction {
  id: string;
  merchant_name: string;
  amount: number;
  ai_category_id?: string;
  status: string;
}

interface CorrectionDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  transaction: Transaction | null;
  categories: Category[];
  onSave: (transactionId: string, newCategoryId: string) => Promise<void>;
}

export const CorrectionDrawer: React.FC<CorrectionDrawerProps> = ({
  isOpen,
  onClose,
  transaction,
  categories,
  onSave,
}) => {
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('');
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Safe filter using fallback array to prevent "Cannot read properties of undefined (reading 'filter')"
  const filtered = (categories || []).filter((c) =>
    c.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (!isOpen || !transaction) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCategoryId) {
      setError('Please select a category');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);
      await onSave(transaction.id, selectedCategoryId);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save correction');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black bg-opacity-50">
      <div className="w-full max-w-md bg-white h-full p-6 shadow-xl flex flex-col justify-between overflow-y-auto">
        <div>
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-gray-800">Correct Category</h2>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-700 font-semibold"
            >
              ✕
            </button>
          </div>

          <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <p className="text-sm text-gray-500">Transaction</p>
            <p className="text-lg font-semibold text-gray-800">{transaction.merchant_name}</p>
            <p className="text-md font-medium text-gray-600">${transaction.amount.toFixed(2)}</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-md text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Search Categories
            </label>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Type to filter..."
              className="w-full p-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          <div className="mb-6">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Select New Category
            </label>
            <div className="max-h-60 overflow-y-auto border border-gray-200 rounded-md divide-y divide-gray-100">
              {filtered.length > 0 ? (
                filtered.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setSelectedCategoryId(cat.id)}
                    className={`w-full text-left px-4 py-3 text-sm flex justify-between items-center hover:bg-blue-50 ${
                      selectedCategoryId === cat.id ? 'bg-blue-100 font-semibold text-blue-800' : 'text-gray-700'
                    }`}
                  >
                    <span>{cat.name}</span>
                    {cat.coa_code && (
                      <span className="text-xs text-gray-400">({cat.coa_code})</span>
                    )}
                  </button>
                ))
              ) : (
                <div className="p-4 text-sm text-gray-500 text-center">
                  No categories found
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex gap-3 pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="w-1/2 py-2 px-4 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting || !selectedCategoryId}
            className="w-1/2 py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {isSubmitting ? 'Saving...' : 'Save Correction'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CorrectionDrawer;