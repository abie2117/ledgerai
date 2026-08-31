'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/supabase-browser';
import { QueryBar } from '@/components/QueryBar';

interface Transaction {
  id: string;
  name?: string;
  merchant_name?: string;
  amount: number;
  date: string;
  category: string;
  account_id: string;
}

type DateFilterType = 'this_month' | 'last_30_days' | 'all_time' | 'custom';

export default function DashboardPage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string>('6961bb92-6276-4fbc-adb5-97dab7cfe245');

  // Date Range State
  const [dateFilter, setDateFilter] = useState<DateFilterType>('all_time');
  const [customStartDate, setCustomStartDate] = useState<string>('');
  const [customEndDate, setCustomEndDate] = useState<string>('');

  const router = useRouter();
  const supabase = createBrowserSupabaseClient();

  useEffect(() => {
    async function checkAuthAndFetchData() {
      setLoading(true);

      const {
        data: { user },
      } = await supabase.auth.getUser();

      const activeUserId = user?.id || '6961bb92-6276-4fbc-adb5-97dab7cfe245';
      setUserId(activeUserId);

      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', activeUserId)
        .order('date', { ascending: false });

      if (!error && data) {
        setTransactions(data);
      }
      setLoading(false);
    }

    checkAuthAndFetchData();
  }, [supabase]);

  async function handleCategoryChange(
    txId: string,
    merchantName: string,
    newCategory: string
  ) {
    setTransactions((prev) =>
      prev.map((tx) => (tx.id === txId ? { ...tx, category: newCategory } : tx))
    );

    const { error: txError } = await supabase
      .from('transactions')
      .update({ category: newCategory })
      .eq('id', txId);

    if (txError) {
      console.error('Transaction category update failed:', txError);
    }

    if (userId && merchantName) {
      const { error: ruleError } = await supabase
        .from('category_rules')
        .upsert({
          user_id: userId,
          merchant_pattern: merchantName.toLowerCase().trim(),
          category: newCategory,
        });

      if (ruleError) {
        console.error('Category rule upsert failed:', ruleError);
      }
    }
  }

  const filteredTransactions = useMemo(() => {
    if (dateFilter === 'all_time') return transactions;

    const now = new Date();

    return transactions.filter((tx) => {
      const txDate = new Date(tx.date);

      if (dateFilter === 'this_month') {
        return (
          txDate.getMonth() === now.getMonth() &&
          txDate.getFullYear() === now.getFullYear()
        );
      }

      if (dateFilter === 'last_30_days') {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        return txDate >= thirtyDaysAgo && txDate <= now;
      }

      if (dateFilter === 'custom') {
        if (!customStartDate && !customEndDate) return true;
        const start = customStartDate
          ? new Date(customStartDate)
          : new Date('1970-01-01');
        const end = customEndDate
          ? new Date(customEndDate)
          : new Date('2099-12-31');
        return txDate >= start && txDate <= end;
      }

      return true;
    });
  }, [transactions, dateFilter, customStartDate, customEndDate]);

  function exportToCSV() {
    if (filteredTransactions.length === 0) return;

    const headers = ['#', 'Date', 'Merchant', 'Category', 'Amount'];
    const rows = filteredTransactions.map((tx, idx) => [
      idx + 1,
      tx.date,
      `"${(tx.merchant_name || tx.name || 'Unknown Merchant').replace(/"/g, '""')}"`,
      `"${(tx.category || 'Uncategorized').replace(/"/g, '""')}"`,
      tx.amount < 0
        ? `+${Math.abs(tx.amount).toFixed(2)}`
        : `-${tx.amount.toFixed(2)}`,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join(
      '\n'
    );
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute(
      'download',
      `LedgerAI_Report_${dateFilter}_${new Date().toISOString().split('T')[0]}.csv`
    );
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  const analytics = useMemo(() => {
    const totalSpend = filteredTransactions
      .filter((t) => t.amount > 0)
      .reduce((sum, t) => sum + t.amount, 0);

    const totalIncome = filteredTransactions
      .filter((t) => t.amount < 0)
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);

    const netCashFlow = totalIncome - totalSpend;

    const categoryTotals: Record<string, number> = {};
    filteredTransactions.forEach((t) => {
      const categoryName = t.category?.trim();
      if (t.amount > 0 && categoryName && categoryName !== 'Uncategorized') {
        categoryTotals[categoryName] =
          (categoryTotals[categoryName] || 0) + t.amount;
      }
    });

    const sortedCategories = Object.entries(categoryTotals).sort(
      (a, b) => b[1] - a[1]
    );
    const topCategory =
      sortedCategories.length > 0 ? sortedCategories[0][0] : 'None';

    return { totalSpend, netCashFlow, topCategory };
  }, [filteredTransactions]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '100vh',
          backgroundColor: '#070b14',
          color: '#38bdf8',
          fontSize: 15,
          fontWeight: 500,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        }}
      >
        Initializing LedgerAI Quantum Core...
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: '#070b14',
        minHeight: '100vh',
        padding: '40px 24px',
        fontFamily:
          'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        color: '#f8fafc',
      }}
    >
      <div style={{ maxWidth: 1160, margin: '0 auto' }}>
        
        {/* Header Bar with Sophisticated Glowing Unique Logo & Action Controls */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 36,
            paddingBottom: 24,
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background: 'linear-gradient(135deg, #0b1329 0%, #030712 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 0 22px rgba(56, 189, 248, 0.4), inset 0 0 10px rgba(129, 140, 248, 0.2)',
                border: '1.5px solid rgba(56, 189, 248, 0.6)',
                position: 'relative',
              }}
            >
              <svg
                width="28"
                height="28"
                viewBox="0 0 32 32"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id="neon-glow" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#38bdf8" />
                    <stop offset="0.5" stopColor="#818cf8" />
                    <stop offset="1" stopColor="#c084fc" />
                  </linearGradient>
                  <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
                    <feGaussianBlur stdDeviation="1.5" result="blur" />
                    <feComposite in="SourceGraphic" in2="blur" operator="over" />
                  </filter>
                </defs>
                <path
                  d="M16 3L28 9.5V22.5L16 29L4 22.5V9.5L16 3Z"
                  stroke="url(#neon-glow)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                  filter="url(#glow)"
                />
                <path
                  d="M16 9L22 12.5V19.5L16 23L10 19.5V12.5L16 9Z"
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                  strokeOpacity="0.7"
                  strokeLinejoin="round"
                />
                <circle cx="16" cy="16" r="3" fill="#818cf8" />
              </svg>
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <h1
                  style={{
                    fontSize: 26,
                    fontWeight: 800,
                    letterSpacing: '-0.03em',
                    color: '#ffffff',
                    margin: 0,
                  }}
                >
                  Ledger<span style={{ color: '#38bdf8' }}>AI</span>
                </h1>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    backgroundColor: 'rgba(56, 189, 248, 0.12)',
                    color: '#38bdf8',
                    border: '1px solid rgba(56, 189, 248, 0.3)',
                    padding: '2px 8px',
                    borderRadius: 6,
                    letterSpacing: '0.08em',
                  }}
                >
                  ENTERPRISE
                </span>
              </div>
              <p
                style={{
                  fontSize: 13,
                  color: '#94a3b8',
                  margin: '4px 0 0 0',
                  fontWeight: 400,
                }}
              >
                Autonomous financial tracking & intelligent multi-account liquidity
              </p>
            </div>
          </div>

          {/* Action Group: Connect Bank, Categorize, and Export CSV */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={() => {
                // Plaid Link trigger handler placeholder
                alert('Triggering Plaid Link flow...');
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 18px',
                backgroundColor: '#0f172a',
                color: '#38bdf8',
                borderRadius: 10,
                border: '1px solid rgba(56, 189, 248, 0.4)',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
                boxShadow: '0 4px 14px rgba(56, 189, 248, 0.15)',
                transition: 'all 0.2s ease',
              }}
            >
              <span>Connect Your Bank</span>
            </button>

            <button
              onClick={() => {
                // Free/Local Categorization trigger handler placeholder
                alert('Running local rule categorization engine...');
              }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 18px',
                backgroundColor: '#0f172a',
                color: '#818cf8',
                borderRadius: 10,
                border: '1px solid rgba(129, 140, 248, 0.4)',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: 14,
                boxShadow: '0 4px 14px rgba(129, 140, 248, 0.15)',
                transition: 'all 0.2s ease',
              }}
            >
              <span>Categorize (Free/Local)</span>
            </button>

            <button
              onClick={exportToCSV}
              disabled={filteredTransactions.length === 0}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '11px 20px',
                backgroundColor: filteredTransactions.length === 0 ? '#1e293b' : '#0284c7',
                color: '#ffffff',
                borderRadius: 10,
                border: '1px solid rgba(255, 255, 255, 0.1)',
                fontWeight: 600,
                cursor: filteredTransactions.length === 0 ? 'not-allowed' : 'pointer',
                fontSize: 14,
                boxShadow: '0 4px 14px rgba(2, 132, 199, 0.3)',
                transition: 'all 0.2s ease',
              }}
            >
              <span>Export CSV Report</span>
              <span
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.2)',
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontSize: 12,
                }}
              >
                {filteredTransactions.length}
              </span>
            </button>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 24,
            backgroundColor: '#0f172a',
            padding: '14px 22px',
            borderRadius: 12,
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 4px 20px rgba(0, 0, 0, 0.4)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#94a3b8',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Timeframe Filter
            </span>
            <select
              value={dateFilter}
              onChange={(e) =>
                setDateFilter(e.target.value as DateFilterType)
              }
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                border: '1px solid rgba(255, 255, 255, 0.1)',
                fontSize: 13,
                backgroundColor: '#1e293b',
                color: '#f8fafc',
                fontWeight: 500,
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="all_time">All Time</option>
              <option value="this_month">This Month</option>
              <option value="last_30_days">Last 30 Days</option>
              <option value="custom">Custom Range</option>
            </select>

            {dateFilter === 'custom' && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginLeft: 8,
                }}
              >
                <input
                  type="date"
                  value={customStartDate}
                  onChange={(e) => setCustomStartDate(e.target.value)}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    fontSize: 13,
                    backgroundColor: '#1e293b',
                    color: '#fff',
                  }}
                />
                <span style={{ fontSize: 13, color: '#64748b' }}>to</span>
                <input
                  type="date"
                  value={customEndDate}
                  onChange={(e) => setCustomEndDate(e.target.value)}
                  style={{
                    padding: '7px 10px',
                    borderRadius: 6,
                    border: '1px solid rgba(255, 255, 255, 0.1)',
                    fontSize: 13,
                    backgroundColor: '#1e293b',
                    color: '#fff',
                  }}
                />
              </div>
            )}
          </div>

          <div style={{ fontSize: 13, color: '#94a3b8', fontWeight: 500 }}>
            Active View: <strong style={{ color: '#38bdf8' }}>{filteredTransactions.length} records</strong>
          </div>
        </div>

        {/* Analytics Cards with Rich Color Highlights */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 20,
            marginBottom: 28,
          }}
        >
          {/* Total Spend Card */}
          <div
            style={{
              padding: '22px 24px',
              backgroundColor: '#0f172a',
              borderRadius: 14,
              border: '1px solid rgba(56, 189, 248, 0.3)',
              backgroundImage: 'linear-gradient(135deg, rgba(56, 189, 248, 0.08) 0%, rgba(15, 23, 42, 0) 100%)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: '#38bdf8',
                fontWeight: 700,
                letterSpacing: '0.08em',
                marginBottom: 10,
              }}
            >
              TOTAL SPEND
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: '#ffffff',
                letterSpacing: '-0.02em',
              }}
            >
              ${analytics.totalSpend.toFixed(2)}
            </div>
          </div>

          {/* Top Spending Category Card */}
          <div
            style={{
              padding: '22px 24px',
              backgroundColor: '#0f172a',
              borderRadius: 14,
              border: '1px solid rgba(129, 140, 248, 0.3)',
              backgroundImage: 'linear-gradient(135deg, rgba(129, 140, 248, 0.08) 0%, rgba(15, 23, 42, 0) 100%)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: '#818cf8',
                fontWeight: 700,
                letterSpacing: '0.08em',
                marginBottom: 10,
              }}
            >
              TOP SPENDING CATEGORY
            </div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 800,
                color: '#ffffff',
                letterSpacing: '-0.01em',
              }}
            >
              {analytics.topCategory}
            </div>
          </div>

          {/* Net Cash Flow Card */}
          <div
            style={{
              padding: '22px 24px',
              backgroundColor: '#0f172a',
              borderRadius: 14,
              border: `1px solid ${analytics.netCashFlow >= 0 ? 'rgba(74, 222, 128, 0.35)' : 'rgba(248, 113, 113, 0.35)'}`,
              backgroundImage: analytics.netCashFlow >= 0 
                ? 'linear-gradient(135deg, rgba(74, 222, 128, 0.08) 0%, rgba(15, 23, 42, 0) 100%)'
                : 'linear-gradient(135deg, rgba(248, 113, 113, 0.08) 0%, rgba(15, 23, 42, 0) 100%)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.3)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: analytics.netCashFlow >= 0 ? '#4ade80' : '#f87171',
                fontWeight: 700,
                letterSpacing: '0.08em',
                marginBottom: 10,
              }}
            >
              NET CASH FLOW
            </div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 800,
                color: analytics.netCashFlow >= 0 ? '#4ade80' : '#f87171',
                letterSpacing: '-0.02em',
              }}
            >
              ${analytics.netCashFlow.toFixed(2)}
            </div>
          </div>
        </div>

        {/* Natural Language AI Query Bar */}
        <div style={{ marginBottom: 28 }}>
          <QueryBar clientId={userId} />
        </div>

        {/* Transaction Table Card */}
        <div
          style={{
            backgroundColor: '#0f172a',
            borderRadius: 14,
            border: '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '60px 140px 1fr 220px 140px',
              padding: '16px 24px',
              backgroundColor: '#111827',
              borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
              fontSize: 12,
              fontWeight: 700,
              color: '#94a3b8',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            <div>#</div>
            <div>Date</div>
            <div>Merchant</div>
            <div>Category</div>
            <div style={{ textAlign: 'right' }}>Amount</div>
          </div>

          {filteredTransactions.length === 0 ? (
            <div
              style={{
                padding: '56px 24px',
                textAlign: 'center',
                color: '#64748b',
                fontSize: 14,
              }}
            >
              No matching transactions found for this period.
            </div>
          ) : (
            filteredTransactions.map((tx, index) => {
              const displayName =
                tx.merchant_name || tx.name || 'Unknown Merchant';
              const isIncome = tx.amount < 0;

              return (
                <div
                  key={tx.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '60px 140px 1fr 220px 140px',
                    alignItems: 'center',
                    padding: '16px 24px',
                    borderBottom:
                      index === filteredTransactions.length - 1
                        ? 'none'
                        : '1px solid rgba(255, 255, 255, 0.04)',
                    fontSize: 14,
                    transition: 'background-color 0.15s ease',
                  }}
                >
                  <div style={{ color: '#64748b', fontSize: 13, fontWeight: 500 }}>
                    {index + 1}
                  </div>
                  <div style={{ color: '#94a3b8', fontWeight: 500 }}>
                    {tx.date}
                  </div>
                  <div style={{ fontWeight: 600, color: '#f8fafc' }}>
                    {displayName}
                  </div>
                  <div>
                    <select
                      value={tx.category || 'Uncategorized'}
                      onChange={(e) =>
                        handleCategoryChange(
                          tx.id,
                          displayName,
                          e.target.value
                        )
                      }
                      style={{
                        padding: '7px 12px',
                        borderRadius: 8,
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        fontSize: 13,
                        fontWeight: 500,
                        color: '#f8fafc',
                        backgroundColor: '#1e293b',
                        cursor: 'pointer',
                        outline: 'none',
                        width: '90%',
                      }}
                    >
                      <option value="Uncategorized">Uncategorized</option>
                      <option value="Food & Dining">Food & Dining</option>
                      <option value="Transportation">Transportation</option>
                      <option value="Software & Tech">Software & Tech</option>
                      <option value="Transfer / Income">Transfer / Income</option>
                      <option value="Shopping">Shopping</option>
                      <option value="Bills & Utilities">Bills & Utilities</option>
                    </select>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span
                      style={{
                        display: 'inline-block',
                        padding: '5px 12px',
                        borderRadius: 20,
                        fontSize: 13,
                        fontWeight: 700,
                        backgroundColor: isIncome ? 'rgba(74, 222, 128, 0.1)' : 'rgba(255, 255, 255, 0.05)',
                        color: isIncome ? '#4ade80' : '#f8fafc',
                        border: `1px solid ${isIncome ? 'rgba(74, 222, 128, 0.2)' : 'rgba(255, 255, 255, 0.08)'}`,
                      }}
                    >
                      {isIncome
                        ? `+$${Math.abs(tx.amount).toFixed(2)}`
                        : `$${tx.amount.toFixed(2)}`}
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}