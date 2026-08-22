"use client";

import React, { useState } from "react";
import { confirmTransaction, correctTransaction } from "../app/actions/reviewTransaction";

interface Category {
  id: string;
  name: string;
}

interface Transaction {
  id: string;
  client_id: string; // REQUIRED — confirmTransaction/correctTransaction both need this.
                      // Make sure whatever fetches initialData (e.g. page.tsx) selects
                      // client_id on the transactions query, or this will be undefined
                      // again and reproduce the exact "invalid input syntax for type uuid"
                      // error from before.
  merchant_name?: string;
  amount: number;
  ai_category_id?: string;
  suggested_category?: string;
  status?: string;
}

interface Props {
  initialData: Transaction[];
  categories?: Category[];
}

export function TransactionReviewTable({ initialData, categories = [] }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [loading, setLoading] = useState<string | null>(null);

  const handleConfirm = async (tx: Transaction) => {
    try {
      setLoading(tx.id);
      console.log("Confirming transaction:", tx.id, "clientId:", tx.client_id);

      // FIX: pass the object shape confirmTransaction expects — a raw
      // string here was the cause of "transactionId: undefined" before.
      const result = await confirmTransaction({
        transactionId: tx.id,
        clientId: tx.client_id,
      });

      // FIX: these actions return { success, error } on failure rather
      // than throwing — the previous try/catch never caught a real
      // failure, which is why failed confirms looked identical to
      // successful ones in the UI.
      if (!result.success) {
        alert(`Failed to confirm: ${result.error ?? "Unknown error"}`);
      }
    } catch (err) {
      console.error("Confirm error:", err);
      alert("Failed to confirm transaction. Check console for details.");
    } finally {
      setLoading(null);
    }
  };

  const handleSaveCorrection = async (tx: Transaction) => {
    if (!selectedCategory) {
      alert("Please select a category first!");
      return;
    }

    try {
      setLoading(tx.id);
      console.log("Correcting transaction:", tx.id, "clientId:", tx.client_id, "to category:", selectedCategory);

      const result = await correctTransaction({
        transactionId: tx.id,
        clientId: tx.client_id, // FIX: this was missing entirely before —
                                  // it silently became `undefined`, which is
                                  // what actually caused the correctTransaction
                                  // "invalid input syntax for type uuid" error.
        fromCategoryId: tx.ai_category_id || null,
        toCategoryId: selectedCategory,
      });

      if (!result.success) {
        alert(`Failed to save correction: ${result.error ?? "Unknown error"}`);
        return;
      }

      setEditingId(null);
    } catch (err) {
      console.error("Correction error:", err);
      alert("Failed to save correction. Check console for details.");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow overflow-hidden border border-slate-200">
      <table className="w-full text-left border-collapse">
        <thead className="bg-slate-100 border-b border-slate-200">
          <tr>
            <th className="p-3 font-semibold text-slate-700">Merchant</th>
            <th className="p-3 font-semibold text-slate-700">Amount</th>
            <th className="p-3 font-semibold text-slate-700">Category</th>
            <th className="p-3 font-semibold text-slate-700">Status</th>
            <th className="p-3 font-semibold text-slate-700">Action</th>
          </tr>
        </thead>
        <tbody>
          {initialData.map((tx) => (
            <tr key={tx.id} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="p-3 font-medium text-slate-800">{tx.merchant_name}</td>
              <td className="p-3 text-slate-700">${tx.amount}</td>
              <td className="p-3">
                {editingId === tx.id ? (
                  <select
                    className="border border-slate-300 rounded p-1 text-sm bg-white"
                    value={selectedCategory}
                    onChange={(e) => setSelectedCategory(e.target.value)}
                  >
                    <option value="">Select Category</option>
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-slate-800">{tx.suggested_category}</span>
                )}
              </td>
              <td className="p-3">
                <span className={`px-2 py-1 text-xs rounded font-medium ${
                  tx.status === "confirmed" 
                    ? "bg-green-100 text-green-800" 
                    : "bg-yellow-100 text-yellow-800"
                }`}>
                  {tx.status}
                </span>
              </td>
              <td className="p-3 space-x-2">
                {editingId === tx.id ? (
                  <>
                    <button
                      onClick={() => handleSaveCorrection(tx)}
                      disabled={loading === tx.id}
                      className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
                    >
                      {loading === tx.id ? "Saving..." : "Save"}
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="px-3 py-1 bg-slate-300 text-slate-700 rounded text-sm hover:bg-slate-400"
                    >
                      Cancel
                    </button>
                  </>
                ) : tx.status !== "confirmed" ? (
                  <>
                    <button
                      onClick={() => handleConfirm(tx)}
                      disabled={loading === tx.id}
                      className="px-3 py-1 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
                    >
                      {loading === tx.id ? "Updating..." : "Confirm"}
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(tx.id);
                        setSelectedCategory(tx.ai_category_id || "");
                      }}
                      className="px-3 py-1 bg-slate-200 text-slate-700 rounded text-sm hover:bg-slate-300 cursor-pointer"
                    >
                      Correct
                    </button>
                  </>
                ) : (
                  <span className="text-xs text-slate-400 font-medium">Confirmed</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
