'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase-browser';
import { QueryBar } from '@/components/QueryBar';
import PlaidLinkButton from '@/components/PlaidLinkButton';

console.log('🔥 DASHBOARD PAGE LOADED');

interface Transaction {
  id: string;
  user_id?: string;
  name?: string;
  merchant_name?: string;
  amount: number;
  date: string;
  posted_date?: string;
  category?: string;
  account_id?: string;
}

type DateFilterType =
  | 'this_month'
  | 'last_30_days'
  | 'all_time'
  | 'custom';

export default function DashboardPage() {
  const router = useRouter();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const [dateFilter, setDateFilter] =
    useState<DateFilterType>('all_time');

  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  const [isCategorizing, setIsCategorizing] = useState(false);
  const [categoryMessage, setCategoryMessage] = useState<string | null>(null);

  async function loadTransactions(currentUserId: string) {
    console.log(
      '📊 Loading transactions for user:',
      currentUserId
    );

    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', currentUserId)
      .order('posted_date', {
        ascending: false,
      });

    if (error) {
      console.error(
        '❌ Transaction fetch failed:',
        error
      );

      /*
       * Some older rows/projects may use "date".
       * If posted_date does not work, try date.
       */
      const fallback = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', currentUserId)
        .order('date', {
          ascending: false,
        });

      if (fallback.error) {
        console.error(
          '❌ Transaction fallback fetch failed:',
          fallback.error
        );

        setTransactions([]);
        return;
      }

      console.log(
        '📦 Transactions returned:',
        fallback.data
      );

      setTransactions(
        (fallback.data as Transaction[]) ?? []
      );

      return;
    }

    console.log(
      '📦 Transactions returned:',
      data
    );

    setTransactions(
      (data as Transaction[]) ?? []
    );
  }

  useEffect(() => {
    console.log('🔥 DASHBOARD useEffect RUNNING');

    let mounted = true;

    async function checkAuthAndFetchData() {
      setLoading(true);

      try {
        console.log(
          '🔐 Checking Supabase authentication...'
        );

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError) {
          console.error(
            '❌ Authentication check failed:',
            authError
          );
        }

        console.log(
          '👤 Current Supabase user:',
          user
        );

        if (!user) {
          console.log(
            '❌ No authenticated user. Redirecting to /login'
          );

          if (mounted) {
            setLoading(false);
          }

          router.replace('/login');
          return;
        }

        if (!mounted) return;

        console.log(
          '✅ Authenticated user:',
          user.id
        );

        setUserId(user.id);

        await loadTransactions(user.id);

        if (mounted) {
          setLoading(false);
        }
      } catch (error) {
        console.error(
          '❌ Dashboard initialization failed:',
          error
        );

        if (mounted) {
          setLoading(false);
        }
      }
    }

    checkAuthAndFetchData();

    return () => {
      mounted = false;
    };
  }, [router]);

  async function refreshTransactions() {
    if (!userId) return;

    await loadTransactions(userId);
  }

  async function handleLocalCategorization() {
    if (!userId) {
      setCategoryMessage(
        'You must be signed in to categorize transactions.'
      );
      return;
    }

    try {
      setIsCategorizing(true);
      setCategoryMessage(null);

      console.log(
        '🤖 Running local categorization...'
      );

      const response = await fetch(
        '/api/categorize-local',
        {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            user_id: userId,
            client_id: userId,
          }),
        }
      );

      const data = await response.json();

      console.log(
        '📦 Local categorization response:',
        data
      );

      if (!response.ok) {
        console.error(
          '❌ Local categorization failed:',
          data
        );

        setCategoryMessage(
          data?.error ||
            'Local categorization failed.'
        );

        return;
      }

      setCategoryMessage(
        `✅ Categorization complete. ${
          data?.updated ??
          data?.count ??
          0
        } transaction(s) updated.`
      );

      await refreshTransactions();
    } catch (error) {
      console.error(
        '❌ Local categorization error:',
        error
      );

      setCategoryMessage(
        'Something went wrong while categorizing transactions.'
      );
    } finally {
      setIsCategorizing(false);
    }
  }

  async function handleCategoryChange(
    txId: string,
    merchantName: string,
    newCategory: string
  ) {
    setTransactions((prev) =>
      prev.map((tx) =>
        tx.id === txId
          ? {
              ...tx,
              category: newCategory,
            }
          : tx
      )
    );

    const { error: txError } = await supabase
      .from('transactions')
      .update({
        category: newCategory,
      })
      .eq('id', txId);

    if (txError) {
      console.error(
        'Transaction category update failed:',
        txError
      );

      await refreshTransactions();
      return;
    }

    if (userId && merchantName) {
      const { error: ruleError } =
        await supabase
          .from('category_rules')
          .upsert({
            user_id: userId,
            merchant_pattern:
              merchantName
                .toLowerCase()
                .trim(),
            category: newCategory,
          });

      if (ruleError) {
        console.error(
          'Category rule upsert failed:',
          ruleError
        );
      }
    }
  }

  const filteredTransactions = useMemo(() => {
    if (dateFilter === 'all_time') {
      return transactions;
    }

    const now = new Date();

    return transactions.filter((tx) => {
      const transactionDate =
        tx.posted_date ||
        tx.date;

      const txDate =
        new Date(transactionDate);

      if (dateFilter === 'this_month') {
        return (
          txDate.getMonth() ===
            now.getMonth() &&
          txDate.getFullYear() ===
            now.getFullYear()
        );
      }

      if (dateFilter === 'last_30_days') {
        const thirtyDaysAgo =
          new Date();

        thirtyDaysAgo.setDate(
          now.getDate() - 30
        );

        return (
          txDate >= thirtyDaysAgo &&
          txDate <= now
        );
      }

      if (dateFilter === 'custom') {
        if (
          !customStartDate &&
          !customEndDate
        ) {
          return true;
        }

        const start = customStartDate
          ? new Date(
              `${customStartDate}T00:00:00`
            )
          : new Date(
              '1970-01-01T00:00:00'
            );

        const end = customEndDate
          ? new Date(
              `${customEndDate}T23:59:59.999`
            )
          : new Date(
              '2099-12-31T23:59:59.999'
            );

        return (
          txDate >= start &&
          txDate <= end
        );
      }

      return true;
    });
  }, [
    transactions,
    dateFilter,
    customStartDate,
    customEndDate,
  ]);

  function exportToCSV() {
    if (
      filteredTransactions.length === 0
    ) {
      return;
    }

    const headers = [
      '#',
      'Date',
      'Merchant',
      'Category',
      'Amount',
    ];

    const rows =
      filteredTransactions.map(
        (tx, idx) => {
          const transactionDate =
            tx.posted_date ||
            tx.date;

          return [
            idx + 1,
            transactionDate,
            `"${(
              tx.merchant_name ||
              tx.name ||
              'Unknown Merchant'
            ).replace(/"/g, '""')}"`,
            `"${(
              tx.category ||
              'Uncategorized'
            ).replace(/"/g, '""')}"`,
            tx.amount < 0
              ? `+${Math.abs(
                  tx.amount
                ).toFixed(2)}`
              : `-${tx.amount.toFixed(
                  2
                )}`,
          ];
        }
      );

    const csvContent = [
      headers.join(','),
      ...rows.map((row) =>
        row.join(',')
      ),
    ].join('\n');

    const blob = new Blob(
      [csvContent],
      {
        type:
          'text/csv;charset=utf-8;',
      }
    );

    const url =
      URL.createObjectURL(blob);

    const link =
      document.createElement('a');

    link.setAttribute(
      'href',
      url
    );

    link.setAttribute(
      'download',
      `LedgerAI_Report_${dateFilter}_${new Date()
        .toISOString()
        .split('T')[0]}.csv`
    );

    document.body.appendChild(link);

    link.click();

    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  const analytics = useMemo(() => {
    const totalSpend =
      filteredTransactions
        .filter(
          (transaction) =>
            transaction.amount > 0
        )
        .reduce(
          (sum, transaction) =>
            sum +
            transaction.amount,
          0
        );

    const totalIncome =
      filteredTransactions
        .filter(
          (transaction) =>
            transaction.amount < 0
        )
        .reduce(
          (sum, transaction) =>
            sum +
            Math.abs(
              transaction.amount
            ),
          0
        );

    const netCashFlow =
      totalIncome - totalSpend;

    const categoryTotals: Record<
      string,
      number
    > = {};

    filteredTransactions.forEach(
      (transaction) => {
        const categoryName =
          transaction.category?.trim();

        if (
          transaction.amount > 0 &&
          categoryName &&
          categoryName !==
            'Uncategorized'
        ) {
          categoryTotals[
            categoryName
          ] =
            (categoryTotals[
              categoryName
            ] || 0) +
            transaction.amount;
        }
      }
    );

    const sortedCategories =
      Object.entries(
        categoryTotals
      ).sort(
        (a, b) => b[1] - a[1]
      );

    const topCategory =
      sortedCategories.length > 0
        ? sortedCategories[0][0]
        : 'None';

    return {
      totalSpend,
      totalIncome,
      netCashFlow,
      topCategory,
    };
  }, [filteredTransactions]);

  async function handleSignOut() {
    console.log(
      '🚪 Signing out of LedgerAI...'
    );

    const { error } =
      await supabase.auth.signOut();

    if (error) {
      console.error(
        'LedgerAI sign out failed:',
        error
      );

      return;
    }

    console.log(
      '✅ Signed out successfully'
    );

    router.replace('/login');
  }

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
      <div
        style={{
          maxWidth: 1160,
          margin: '0 auto',
        }}
      >
        {/* HEADER */}

        <div
          style={{
            display: 'flex',
            justifyContent:
              'space-between',
            alignItems: 'center',
            marginBottom: 36,
            paddingBottom: 24,
            borderBottom:
              '1px solid rgba(255,255,255,0.08)',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 16,
            }}
          >
            <div
              style={{
                width: 50,
                height: 50,
                borderRadius: 14,
                background:
                  'linear-gradient(135deg, #0b1329 0%, #030712 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow:
                  '0 0 22px rgba(56,189,248,0.4), inset 0 0 10px rgba(129,140,248,0.2)',
                border:
                  '1.5px solid rgba(56,189,248,0.6)',
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
                  <linearGradient
                    id="neon-glow-dashboard"
                    x1="0"
                    y1="0"
                    x2="32"
                    y2="32"
                    gradientUnits="userSpaceOnUse"
                  >
                    <stop stopColor="#38bdf8" />
                    <stop
                      offset="0.5"
                      stopColor="#818cf8"
                    />
                    <stop
                      offset="1"
                      stopColor="#c084fc"
                    />
                  </linearGradient>
                </defs>

                <path
                  d="M16 3L28 9.5V22.5L16 29L4 22.5V9.5L16 3Z"
                  stroke="url(#neon-glow-dashboard)"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />

                <path
                  d="M16 9L22 12.5V19.5L16 23L10 19.5V12.5L16 9Z"
                  stroke="#38bdf8"
                  strokeWidth="1.5"
                  strokeOpacity="0.7"
                  strokeLinejoin="round"
                />

                <circle
                  cx="16"
                  cy="16"
                  r="3"
                  fill="#818cf8"
                />
              </svg>
            </div>

            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  flexWrap: 'wrap',
                }}
              >
                <h1
                  style={{
                    fontSize: 26,
                    fontWeight: 800,
                    letterSpacing:
                      '-0.03em',
                    color: '#ffffff',
                    margin: 0,
                  }}
                >
                  Ledger
                  <span
                    style={{
                      color: '#38bdf8',
                    }}
                  >
                    AI
                  </span>
                </h1>

                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    backgroundColor:
                      'rgba(56,189,248,0.12)',
                    color: '#38bdf8',
                    border:
                      '1px solid rgba(56,189,248,0.3)',
                    padding:
                      '2px 8px',
                    borderRadius: 6,
                    letterSpacing:
                      '0.08em',
                  }}
                >
                  ENTERPRISE
                </span>
              </div>

              <p
                style={{
                  fontSize: 13,
                  color: '#94a3b8',
                  margin:
                    '4px 0 0 0',
                }}
              >
                Autonomous financial tracking &
                intelligent multi-account liquidity
              </p>
            </div>
          </div>

          {/* ACTIONS */}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            {/* REAL PLAID BUTTON */}

            {userId && (
              <PlaidLinkButton
                selectedClientId={userId}
                onBankConnected={async () => {
                  console.log(
                    '✅ Bank connected. Refreshing transactions...'
                  );

                  await refreshTransactions();
                }}
              />
            )}

            {/* REAL LOCAL CATEGORIZATION */}

            <button
              type="button"
              onClick={
                handleLocalCategorization
              }
              disabled={
                isCategorizing ||
                transactions.length === 0
              }
              style={{
                padding:
                  '11px 18px',
                backgroundColor:
                  isCategorizing ||
                  transactions.length ===
                    0
                    ? '#1e293b'
                    : '#0f172a',
                color:
                  '#818cf8',
                border:
                  '1px solid rgba(129,140,248,0.4)',
                borderRadius: 10,
                fontWeight: 600,
                cursor:
                  isCategorizing ||
                  transactions.length ===
                    0
                    ? 'not-allowed'
                    : 'pointer',
                fontSize: 14,
              }}
            >
              {isCategorizing
                ? 'Categorizing...'
                : 'Categorize (Free/Local)'}
            </button>

            <button
              type="button"
              onClick={exportToCSV}
              disabled={
                filteredTransactions.length ===
                0
              }
              style={{
                padding:
                  '11px 20px',
                backgroundColor:
                  filteredTransactions.length ===
                  0
                    ? '#1e293b'
                    : '#0284c7',
                color:
                  '#ffffff',
                border:
                  '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                fontWeight: 600,
                cursor:
                  filteredTransactions.length ===
                  0
                    ? 'not-allowed'
                    : 'pointer',
                fontSize: 14,
              }}
            >
              Export CSV Report (
              {filteredTransactions.length})
            </button>

            <button
              type="button"
              onClick={handleSignOut}
              style={{
                padding:
                  '11px 18px',
                backgroundColor:
                  '#1e293b',
                color:
                  '#f87171',
                borderRadius: 10,
                border:
                  '1px solid rgba(248,113,113,0.3)',
                fontWeight: 600,
                cursor:
                  'pointer',
                fontSize: 14,
              }}
            >
              Sign Out
            </button>
          </div>
        </div>

        {/* STATUS */}

        {categoryMessage && (
          <div
            style={{
              marginBottom: 20,
              padding:
                '12px 16px',
              backgroundColor:
                categoryMessage.startsWith(
                  '✅'
                )
                  ? 'rgba(74,222,128,0.08)'
                  : 'rgba(248,113,113,0.08)',
              border:
                categoryMessage.startsWith(
                  '✅'
                )
                  ? '1px solid rgba(74,222,128,0.25)'
                  : '1px solid rgba(248,113,113,0.25)',
              borderRadius: 10,
              color:
                categoryMessage.startsWith(
                  '✅'
                )
                  ? '#4ade80'
                  : '#f87171',
              fontSize: 13,
            }}
          >
            {categoryMessage}
          </div>
        )}

        {/* ACTIVE USER */}

        <div
          style={{
            marginBottom: 20,
            fontSize: 13,
            color: '#64748b',
          }}
        >
          Active User:{' '}
          <span
            style={{
              color: '#38bdf8',
              fontWeight: 600,
            }}
          >
            {userId || 'Unknown'}
          </span>
        </div>

        {/* FILTERS */}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent:
              'space-between',
            marginBottom: 24,
            backgroundColor:
              '#0f172a',
            padding:
              '14px 22px',
            borderRadius: 12,
            border:
              '1px solid rgba(255,255,255,0.08)',
            gap: 20,
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: '#94a3b8',
                textTransform:
                  'uppercase',
                letterSpacing:
                  '0.08em',
              }}
            >
              Timeframe Filter
            </span>

            <select
              value={dateFilter}
              onChange={(e) =>
                setDateFilter(
                  e.target.value as DateFilterType
                )
              }
              style={{
                padding:
                  '8px 14px',
                borderRadius: 8,
                border:
                  '1px solid rgba(255,255,255,0.1)',
                fontSize: 13,
                backgroundColor:
                  '#1e293b',
                color:
                  '#f8fafc',
                cursor:
                  'pointer',
              }}
            >
              <option value="all_time">
                All Time
              </option>

              <option value="this_month">
                This Month
              </option>

              <option value="last_30_days">
                Last 30 Days
              </option>

              <option value="custom">
                Custom Range
              </option>
            </select>

            {dateFilter ===
              'custom' && (
              <div
                style={{
                  display: 'flex',
                  alignItems:
                    'center',
                  gap: 8,
                  flexWrap: 'wrap',
                }}
              >
                <input
                  type="date"
                  value={
                    customStartDate
                  }
                  onChange={(e) =>
                    setCustomStartDate(
                      e.target.value
                    )
                  }
                  style={{
                    padding:
                      '7px 10px',
                    borderRadius:
                      6,
                    border:
                      '1px solid rgba(255,255,255,0.1)',
                    backgroundColor:
                      '#1e293b',
                    color:
                      '#fff',
                  }}
                />

                <span
                  style={{
                    color:
                      '#64748b',
                  }}
                >
                  to
                </span>

                <input
                  type="date"
                  value={
                    customEndDate
                  }
                  onChange={(e) =>
                    setCustomEndDate(
                      e.target.value
                    )
                  }
                  style={{
                    padding:
                      '7px 10px',
                    borderRadius:
                      6,
                    border:
                      '1px solid rgba(255,255,255,0.1)',
                    backgroundColor:
                      '#1e293b',
                    color:
                      '#fff',
                  }}
                />
              </div>
            )}
          </div>

          <div
            style={{
              fontSize: 13,
              color:
                '#94a3b8',
            }}
          >
            Active View:{' '}
            <strong
              style={{
                color:
                  '#38bdf8',
              }}
            >
              {
                filteredTransactions.length
              } records
            </strong>
          </div>
        </div>

        {/* ANALYTICS */}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns:
              'repeat(3, minmax(0, 1fr))',
            gap: 20,
            marginBottom: 28,
          }}
        >
          <div
            style={{
              padding:
                '22px 24px',
              backgroundColor:
                '#0f172a',
              borderRadius:
                14,
              border:
                '1px solid rgba(56,189,248,0.3)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color:
                  '#38bdf8',
                fontWeight:
                  700,
                marginBottom:
                  10,
              }}
            >
              TOTAL SPEND
            </div>

            <div
              style={{
                fontSize: 30,
                fontWeight:
                  800,
                color:
                  '#ffffff',
              }}
            >
              $
              {analytics.totalSpend.toFixed(
                2
              )}
            </div>
          </div>

          <div
            style={{
              padding:
                '22px 24px',
              backgroundColor:
                '#0f172a',
              borderRadius:
                14,
              border:
                '1px solid rgba(129,140,248,0.3)',
            }}
          >
            <div
              style={{
                fontSize: 12,
                color:
                  '#818cf8',
                fontWeight:
                  700,
                marginBottom:
                  10,
              }}
            >
              TOP SPENDING CATEGORY
            </div>

            <div
              style={{
                fontSize: 26,
                fontWeight:
                  800,
                color:
                  '#ffffff',
              }}
            >
              {analytics.topCategory}
            </div>
          </div>

          <div
            style={{
              padding:
                '22px 24px',
              backgroundColor:
                '#0f172a',
              borderRadius:
                14,
              border:
                `1px solid ${
                  analytics.netCashFlow >= 0
                    ? 'rgba(74,222,128,0.35)'
                    : 'rgba(248,113,113,0.35)'
                }`,
            }}
          >
            <div
              style={{
                fontSize: 12,
                color:
                  analytics.netCashFlow >= 0
                    ? '#4ade80'
                    : '#f87171',
                fontWeight:
                  700,
                marginBottom:
                  10,
              }}
            >
              NET CASH FLOW
            </div>

            <div
              style={{
                fontSize: 30,
                fontWeight:
                  800,
                color:
                  analytics.netCashFlow >= 0
                    ? '#4ade80'
                    : '#f87171',
              }}
            >
              $
              {analytics.netCashFlow.toFixed(
                2
              )}
            </div>
          </div>
        </div>

        {/* AI QUERY BAR */}

        <div
          style={{
            marginBottom: 28,
          }}
        >
          {userId && (
            <QueryBar
              clientId={userId}
            />
          )}
        </div>

        {/* TRANSACTION TABLE */}

        <div
          style={{
            backgroundColor:
              '#0f172a',
            borderRadius:
              14,
            border:
              '1px solid rgba(255,255,255,0.08)',
            overflow:
              'hidden',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns:
                '60px 140px 1fr 220px 140px',
              padding:
                '16px 24px',
              backgroundColor:
                '#111827',
              borderBottom:
                '1px solid rgba(255,255,255,0.08)',
              fontSize: 12,
              fontWeight: 700,
              color:
                '#94a3b8',
              textTransform:
                'uppercase',
            }}
          >
            <div>#</div>
            <div>Date</div>
            <div>Merchant</div>
            <div>Category</div>
            <div
              style={{
                textAlign:
                  'right',
              }}
            >
              Amount
            </div>
          </div>

          {filteredTransactions.length ===
          0 ? (
            <div
              style={{
                padding:
                  '56px 24px',
                textAlign:
                  'center',
                color:
                  '#64748b',
                fontSize: 14,
              }}
            >
              No matching transactions found
              for this period.
            </div>
          ) : (
            filteredTransactions.map(
              (tx, index) => {
                const displayName =
                  tx.merchant_name ||
                  tx.name ||
                  'Unknown Merchant';

                const transactionDate =
                  tx.posted_date ||
                  tx.date;

                const isIncome =
                  tx.amount < 0;

                return (
                  <div
                    key={tx.id}
                    style={{
                      display:
                        'grid',
                      gridTemplateColumns:
                        '60px 140px 1fr 220px 140px',
                      alignItems:
                        'center',
                      padding:
                        '16px 24px',
                      borderBottom:
                        index ===
                        filteredTransactions.length -
                          1
                          ? 'none'
                          : '1px solid rgba(255,255,255,0.04)',
                      fontSize:
                        14,
                    }}
                  >
                    <div
                      style={{
                        color:
                          '#64748b',
                      }}
                    >
                      {index + 1}
                    </div>

                    <div
                      style={{
                        color:
                          '#94a3b8',
                      }}
                    >
                      {transactionDate}
                    </div>

                    <div
                      style={{
                        fontWeight:
                          600,
                        color:
                          '#f8fafc',
                      }}
                    >
                      {displayName}
                    </div>

                    <div>
                      <select
                        value={
                          tx.category ||
                          'Uncategorized'
                        }
                        onChange={(e) =>
                          handleCategoryChange(
                            tx.id,
                            displayName,
                            e.target.value
                          )
                        }
                        style={{
                          padding:
                            '7px 12px',
                          borderRadius:
                            8,
                          border:
                            '1px solid rgba(255,255,255,0.1)',
                          fontSize:
                            13,
                          fontWeight:
                            500,
                          color:
                            '#f8fafc',
                          backgroundColor:
                            '#1e293b',
                          cursor:
                            'pointer',
                          width:
                            '90%',
                        }}
                      >
                        <option value="Uncategorized">
                          Uncategorized
                        </option>

                        <option value="Food & Dining">
                          Food & Dining
                        </option>

                        <option value="Transportation">
                          Transportation
                        </option>

                        <option value="Software & Tech">
                          Software & Tech
                        </option>

                        <option value="Transfer / Income">
                          Transfer / Income
                        </option>

                        <option value="Shopping">
                          Shopping
                        </option>

                        <option value="Bills & Utilities">
                          Bills & Utilities
                        </option>
                      </select>
                    </div>

                    <div
                      style={{
                        textAlign:
                          'right',
                      }}
                    >
                      <span
                        style={{
                          display:
                            'inline-block',
                          padding:
                            '5px 12px',
                          borderRadius:
                            20,
                          fontSize:
                            13,
                          fontWeight:
                            700,
                          backgroundColor:
                            isIncome
                              ? 'rgba(74,222,128,0.1)'
                              : 'rgba(255,255,255,0.05)',
                          color:
                            isIncome
                              ? '#4ade80'
                              : '#f8fafc',
                        }}
                      >
                        {isIncome
                          ? `+$${Math.abs(
                              tx.amount
                            ).toFixed(2)}`
                          : `$${tx.amount.toFixed(
                              2
                            )}`}
                      </span>
                    </div>
                  </div>
                );
              }
            )
          )}
        </div>
      </div>
    </div>
  );
}
