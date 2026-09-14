'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import QueryBar from '@/components/QueryBar';
import PlaidLinkButton from '@/components/PlaidLinkButton';

interface Transaction {
  id: string;
  user_id?: string | null;
  client_id?: string | null;
  date: string;
  merchant_name?: string | null;
  name?: string | null;
  amount: number;
  category?: string | null;
  account_name?: string | null;
  account_mask?: string | null;
  pending?: boolean | null;
  payment_channel?: string | null;
  iso_currency_code?: string | null;
  personal_finance_category?: {
    primary?: string | null;
    detailed?: string | null;
  } | null;
}

interface Client {
  id: string;
  name: string;
  firm_id?: string | null;
}

interface FirmMembership {
  firm_id: string;
  user_id: string;
  role?: string | null;
}

interface GroupedMerchant {
  merchant: string;
  total: number;
  count: number;
}

const CATEGORY_OPTIONS = [
  'Uncategorized',
  'Advertising',
  'Bank Fees',
  'Contractors',
  'Education',
  'Entertainment',
  'Food & Dining',
  'Insurance',
  'Interest',
  'Legal & Professional',
  'Meals',
  'Office Supplies',
  'Payroll',
  'Rent',
  'Software',
  'Taxes',
  'Travel',
  'Utilities',
];

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

function formatDate(date: string) {
  if (!date) return '—';

  const parsedDate = new Date(`${date}T00:00:00`);

  if (Number.isNaN(parsedDate.getTime())) {
    return date;
  }

  return parsedDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function getMerchantName(transaction: Transaction) {
  return (
    transaction.merchant_name ||
    transaction.name ||
    'Unknown merchant'
  );
}

function getTransactionCategory(transaction: Transaction) {
  if (transaction.category) {
    return transaction.category;
  }

  if (transaction.personal_finance_category?.primary) {
    return transaction.personal_finance_category.primary;
  }

  return 'Uncategorized';
}

function escapeCsvValue(value: string | number | boolean | null | undefined) {
  const stringValue = String(value ?? '');

  return `"${stringValue.replace(/"/g, '""')}"`;
}

export default function DashboardPage() {
  const supabase = createClient();

  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [memberships, setMemberships] = useState<FirmMembership[]>([]);

  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);

  const [loading, setLoading] = useState(true);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All Categories');
  const [accountFilter, setAccountFilter] = useState('All Accounts');

  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(
    null,
  );
  const [savingCategoryId, setSavingCategoryId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    async function loadDashboard() {
      try {
        setLoading(true);
        setErrorMessage('');

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError) {
          throw userError;
        }

        if (!user) {
          window.location.href = '/login';
          return;
        }

        setUserId(user.id);
        setUserEmail(user.email ?? null);

        const { data: membershipData, error: membershipError } =
          await supabase
            .from('firm_users')
            .select('firm_id, user_id, role')
            .eq('user_id', user.id);

        if (membershipError) {
          throw membershipError;
        }

        const loadedMemberships = (membershipData ||
          []) as FirmMembership[];

        setMemberships(loadedMemberships);

        const firmIds = loadedMemberships
          .map((membership) => membership.firm_id)
          .filter(Boolean);

        let loadedClients: Client[] = [];

        if (firmIds.length > 0) {
          const { data: clientData, error: clientError } = await supabase
            .from('clients')
            .select('id, name, firm_id')
            .in('firm_id', firmIds)
            .order('name', { ascending: true });

          if (clientError) {
            throw clientError;
          }

          loadedClients = (clientData || []) as Client[];
        } else {
          const { data: clientData, error: clientError } = await supabase
            .from('clients')
            .select('id, name, firm_id')
            .order('name', { ascending: true });

          if (clientError) {
            throw clientError;
          }

          loadedClients = (clientData || []) as Client[];
        }

        setClients(loadedClients);

        if (loadedClients.length === 0) {
          setSelectedClientId('');
          setTransactions([]);
          return;
        }

        const acmeClient = loadedClients.find(
          (client) =>
            client.name.toLowerCase().trim() === 'acme corp',
        );

        const initialClient = acmeClient || loadedClients[0];

        setSelectedClientId(initialClient.id);
      } catch (error: any) {
        console.error('Error loading dashboard:', error);
        setErrorMessage(
          error?.message || 'Unable to load dashboard data.',
        );
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
  }, [supabase]);

  useEffect(() => {
    async function loadSelectedClientTransactions() {
      if (!selectedClientId) {
        setTransactions([]);
        return;
      }

      try {
        setTransactionsLoading(true);
        setErrorMessage('');

        /*
         * Important:
         * Transactions are loaded by client_id.
         *
         * We intentionally do not filter by the current user's user_id here.
         * Existing transactions may have been created by another user while
         * still belonging to the selected client. Access should be controlled
         * by Supabase RLS and the user's client/firm permissions.
         */
        const {
          data,
          error,
        } = await supabase
          .from('transactions')
          .select('*')
          .eq('client_id', selectedClientId)
          .order('date', {
            ascending: false,
          });

        if (error) {
          throw error;
        }

        setTransactions((data || []) as Transaction[]);
      } catch (error: any) {
        console.error(
          'Error loading selected client transactions:',
          error,
        );

        setTransactions([]);
        setErrorMessage(
          error?.message ||
            'Unable to load transactions for this client.',
        );
      } finally {
        setTransactionsLoading(false);
      }
    }

    loadSelectedClientTransactions();
  }, [selectedClientId, supabase]);

  const selectedClient = useMemo(() => {
    return clients.find((client) => client.id === selectedClientId) || null;
  }, [clients, selectedClientId]);

  const accountOptions = useMemo(() => {
    const accounts = transactions
      .map((transaction) => transaction.account_name || 'Unknown account')
      .filter(Boolean);

    return ['All Accounts', ...Array.from(new Set(accounts)).sort()];
  }, [transactions]);

  const categoryOptions = useMemo(() => {
    const categories = transactions.map((transaction) =>
      getTransactionCategory(transaction),
    );

    return [
      'All Categories',
      ...Array.from(new Set([...CATEGORY_OPTIONS, ...categories])).sort(),
    ];
  }, [transactions]);

  const filteredTransactions = useMemo(() => {
    return transactions.filter((transaction) => {
      const merchant = getMerchantName(transaction).toLowerCase();
      const category = getTransactionCategory(transaction);
      const account = transaction.account_name || 'Unknown account';

      const normalizedSearchTerm = searchTerm.toLowerCase().trim();

      const matchesSearch =
        !normalizedSearchTerm ||
        merchant.includes(normalizedSearchTerm) ||
        category.toLowerCase().includes(normalizedSearchTerm) ||
        account.toLowerCase().includes(normalizedSearchTerm);

      const matchesCategory =
        categoryFilter === 'All Categories' ||
        category === categoryFilter;

      const matchesAccount =
        accountFilter === 'All Accounts' ||
        account === accountFilter;

      const matchesStartDate =
        !startDate || transaction.date >= startDate;

      const matchesEndDate =
        !endDate || transaction.date <= endDate;

      return (
        matchesSearch &&
        matchesCategory &&
        matchesAccount &&
        matchesStartDate &&
        matchesEndDate
      );
    });
  }, [
    transactions,
    searchTerm,
    categoryFilter,
    accountFilter,
    startDate,
    endDate,
  ]);

  const totalSpending = useMemo(() => {
    return filteredTransactions.reduce(
      (total, transaction) => total + Number(transaction.amount || 0),
      0,
    );
  }, [filteredTransactions]);

  const transactionCount = filteredTransactions.length;

  const averageTransaction = useMemo(() => {
    if (transactionCount === 0) {
      return 0;
    }

    return totalSpending / transactionCount;
  }, [totalSpending, transactionCount]);

  const merchantSummary = useMemo<GroupedMerchant[]>(() => {
    const merchantMap = new Map<string, GroupedMerchant>();

    filteredTransactions.forEach((transaction) => {
      const merchant = getMerchantName(transaction);
      const current = merchantMap.get(merchant);

      if (current) {
        current.total += Number(transaction.amount || 0);
        current.count += 1;
      } else {
        merchantMap.set(merchant, {
          merchant,
          total: Number(transaction.amount || 0),
          count: 1,
        });
      }
    });

    return Array.from(merchantMap.values()).sort(
      (a, b) => b.total - a.total,
    );
  }, [filteredTransactions]);

  const categorySummary = useMemo(() => {
    const categoryMap = new Map<string, number>();

    filteredTransactions.forEach((transaction) => {
      const category = getTransactionCategory(transaction);
      const amount = Number(transaction.amount || 0);

      categoryMap.set(
        category,
        (categoryMap.get(category) || 0) + amount,
      );
    });

    return Array.from(categoryMap.entries())
      .map(([category, total]) => ({
        category,
        total,
      }))
      .sort((a, b) => b.total - a.total);
  }, [filteredTransactions]);

  function handleClientChange(
    event: React.ChangeEvent<HTMLSelectElement>,
  ) {
    setSelectedClientId(event.target.value);
    setSearchTerm('');
    setCategoryFilter('All Categories');
    setAccountFilter('All Accounts');
    setStartDate('');
    setEndDate('');
    setSuccessMessage('');
    setErrorMessage('');
  }

  function clearFilters() {
    setSearchTerm('');
    setCategoryFilter('All Categories');
    setAccountFilter('All Accounts');
    setStartDate('');
    setEndDate('');
  }

  async function refreshTransactions() {
    if (!selectedClientId) {
      return;
    }

    try {
      setTransactionsLoading(true);
      setErrorMessage('');
      setSuccessMessage('');

      /*
       * Load transactions by client_id only.
       * Do not add .eq('user_id', userId) here.
       */
      const {
        data,
        error,
      } = await supabase
        .from('transactions')
        .select('*')
        .eq('client_id', selectedClientId)
        .order('date', {
          ascending: false,
        });

      if (error) {
        throw error;
      }

      setTransactions((data || []) as Transaction[]);
      setSuccessMessage('Transactions refreshed successfully.');
    } catch (error: any) {
      console.error('Error refreshing transactions:', error);
      setErrorMessage(
        error?.message || 'Unable to refresh transactions.',
      );
    } finally {
      setTransactionsLoading(false);
    }
  }

  async function handleCategoryChange(
    transactionId: string,
    category: string,
  ) {
    if (!selectedClientId) {
      return;
    }

    try {
      setSavingCategoryId(transactionId);
      setErrorMessage('');
      setSuccessMessage('');

      const { error } = await supabase
        .from('transactions')
        .update({
          category,
        })
        .eq('id', transactionId)
        .eq('client_id', selectedClientId);

      if (error) {
        throw error;
      }

      setTransactions((currentTransactions) =>
        currentTransactions.map((transaction) =>
          transaction.id === transactionId
            ? {
                ...transaction,
                category,
              }
            : transaction,
        ),
      );

      setEditingCategoryId(null);
      setSuccessMessage('Category updated successfully.');
    } catch (error: any) {
      console.error('Error updating transaction category:', error);
      setErrorMessage(
        error?.message || 'Unable to update transaction category.',
      );
    } finally {
      setSavingCategoryId(null);
    }
  }

  async function handleLocalCategorize() {
    if (!selectedClientId || filteredTransactions.length === 0) {
      return;
    }

    try {
      setErrorMessage('');
      setSuccessMessage('');

      const updates = filteredTransactions
        .filter(
          (transaction) =>
            !transaction.category ||
            transaction.category === 'Uncategorized',
        )
        .map((transaction) => {
          const merchant = getMerchantName(transaction).toLowerCase();

          let category = 'Uncategorized';

          if (
            merchant.includes('uber') ||
            merchant.includes('lyft') ||
            merchant.includes('airline') ||
            merchant.includes('hotel')
          ) {
            category = 'Travel';
          } else if (
            merchant.includes('google') ||
            merchant.includes('microsoft') ||
            merchant.includes('adobe') ||
            merchant.includes('slack') ||
            merchant.includes('notion') ||
            merchant.includes('software')
          ) {
            category = 'Software';
          } else if (
            merchant.includes('amazon') ||
            merchant.includes('office') ||
            merchant.includes('staples')
          ) {
            category = 'Office Supplies';
          } else if (
            merchant.includes('restaurant') ||
            merchant.includes('cafe') ||
            merchant.includes('coffee') ||
            merchant.includes('doordash') ||
            merchant.includes('grubhub')
          ) {
            category = 'Food & Dining';
          } else if (
            merchant.includes('facebook') ||
            merchant.includes('meta') ||
            merchant.includes('google ads') ||
            merchant.includes('advertising')
          ) {
            category = 'Advertising';
          } else if (
            merchant.includes('electric') ||
            merchant.includes('water') ||
            merchant.includes('utility') ||
            merchant.includes('internet')
          ) {
            category = 'Utilities';
          } else if (
            merchant.includes('bank') ||
            merchant.includes('fee') ||
            merchant.includes('stripe')
          ) {
            category = 'Bank Fees';
          }

          return {
            id: transaction.id,
            category,
          };
        });

      if (updates.length === 0) {
        setSuccessMessage(
          'There are no uncategorized transactions to update.',
        );
        return;
      }

      for (const update of updates) {
        const { error } = await supabase
          .from('transactions')
          .update({
            category: update.category,
          })
          .eq('id', update.id)
          .eq('client_id', selectedClientId);

        if (error) {
          throw error;
        }
      }

      setTransactions((currentTransactions) =>
        currentTransactions.map((transaction) => {
          const update = updates.find(
            (item) => item.id === transaction.id,
          );

          if (!update) {
            return transaction;
          }

          return {
            ...transaction,
            category: update.category,
          };
        }),
      );

      setSuccessMessage(
        `${updates.length} transaction${
          updates.length === 1 ? '' : 's'
        } categorized successfully.`,
      );
    } catch (error: any) {
      console.error('Error categorizing transactions:', error);
      setErrorMessage(
        error?.message || 'Unable to categorize transactions.',
      );
    }
  }

  function exportTransactionsToCsv() {
    if (filteredTransactions.length === 0) {
      setErrorMessage('There are no transactions to export.');
      return;
    }

    const headers = [
      'Date',
      'Merchant',
      'Amount',
      'Category',
      'Account',
      'Account Mask',
      'Pending',
      'Payment Channel',
      'Currency',
    ];

    const rows = filteredTransactions.map((transaction) => [
      transaction.date,
      getMerchantName(transaction),
      Number(transaction.amount || 0).toFixed(2),
      getTransactionCategory(transaction),
      transaction.account_name || '',
      transaction.account_mask || '',
      transaction.pending ? 'Yes' : 'No',
      transaction.payment_channel || '',
      transaction.iso_currency_code || 'USD',
    ]);

    const csvContent = [
      headers.map(escapeCsvValue).join(','),
      ...rows.map((row) => row.map(escapeCsvValue).join(',')),
    ].join('\n');

    const blob = new Blob([csvContent], {
      type: 'text/csv;charset=utf-8;',
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.setAttribute(
      'download',
      `${selectedClient?.name || 'transactions'}-transactions.csv`,
    );

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    URL.revokeObjectURL(url);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-950 px-6 py-10 text-white">
        <div className="mx-auto max-w-7xl">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-8">
            <p className="text-slate-300">Loading dashboard...</p>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-6 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-xl sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-cyan-400">
              LedgerAI
            </p>

            <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
              Financial Dashboard
            </h1>

            <p className="mt-1 text-sm text-slate-400">
              Review, categorize, and analyze client transactions.
            </p>
          </div>

          <div className="flex flex-col items-start gap-2 sm:items-end">
            {userEmail && (
              <p className="text-xs text-slate-400">{userEmail}</p>
            )}

            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:border-red-500 hover:bg-red-500/10 hover:text-red-300"
            >
              Sign out
            </button>
          </div>
        </header>

        {errorMessage && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </div>
        )}

        {successMessage && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {successMessage}
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
              <div className="flex-1">
                <label
                  htmlFor="client"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Active Client
                </label>

                <select
                  id="client"
                  value={selectedClientId}
                  onChange={handleClientChange}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400 md:max-w-md"
                >
                  {clients.length === 0 && (
                    <option value="">No clients available</option>
                  )}

                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>

                {selectedClient && (
                  <p className="mt-2 text-xs text-slate-500">
                    Viewing transactions for {selectedClient.name}
                  </p>
                )}
              </div>

              <div className="flex flex-wrap gap-2">
                <PlaidLinkButton />

                <button
                  type="button"
                  onClick={refreshTransactions}
                  disabled={
                    transactionsLoading || !selectedClientId
                  }
                  className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:border-cyan-400 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {transactionsLoading ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Connected Firms
            </p>

            <p className="mt-2 text-2xl font-bold text-white">
              {memberships.length}
            </p>

            <p className="mt-1 text-xs text-slate-400">
              Firm membership{memberships.length === 1 ? '' : 's'}
            </p>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Total Spending</p>
            <p className="mt-2 text-2xl font-bold text-white">
              {formatCurrency(totalSpending)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Based on current filters
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Transactions</p>
            <p className="mt-2 text-2xl font-bold text-white">
              {transactionCount}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Matching current filters
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Average Transaction</p>
            <p className="mt-2 text-2xl font-bold text-white">
              {formatCurrency(averageTransaction)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Average amount per transaction
            </p>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-sm text-slate-400">Merchants</p>
            <p className="mt-2 text-2xl font-bold text-white">
              {merchantSummary.length}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Unique merchants in view
            </p>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="flex-1">
              <label
                htmlFor="search"
                className="mb-2 block text-sm font-medium text-slate-300"
              >
                Search Transactions
              </label>

              <QueryBar
                value={searchTerm}
                onChange={setSearchTerm}
                placeholder="Search merchant, category, or account..."
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:flex xl:items-end">
              <div>
                <label
                  htmlFor="category-filter"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Category
                </label>

                <select
                  id="category-filter"
                  value={categoryFilter}
                  onChange={(event) =>
                    setCategoryFilter(event.target.value)
                  }
                  className="w-full min-w-[180px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"
                >
                  {categoryOptions.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="account-filter"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Account
                </label>

                <select
                  id="account-filter"
                  value={accountFilter}
                  onChange={(event) =>
                    setAccountFilter(event.target.value)
                  }
                  className="w-full min-w-[180px] rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"
                >
                  {accountOptions.map((account) => (
                    <option key={account} value={account}>
                      {account}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="start-date"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  Start Date
                </label>

                <input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(event) =>
                    setStartDate(event.target.value)
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"
                />
              </div>

              <div>
                <label
                  htmlFor="end-date"
                  className="mb-2 block text-sm font-medium text-slate-300"
                >
                  End Date
                </label>

                <input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(event) =>
                    setEndDate(event.target.value)
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition focus:border-cyan-400"
                />
              </div>

              <button
                type="button"
                onClick={clearFilters}
                className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:border-slate-500 hover:text-white"
              >
                Clear Filters
              </button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1fr_360px]">
          <div className="rounded-2xl border border-slate-800 bg-slate-900">
            <div className="flex flex-col gap-3 border-b border-slate-800 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  Transactions
                </h2>

                <p className="mt-1 text-sm text-slate-400">
                  {transactionsLoading
                    ? 'Loading transactions...'
                    : `${filteredTransactions.length} transaction${
                        filteredTransactions.length === 1
                          ? ''
                          : 's'
                      } shown`}
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleLocalCategorize}
                  disabled={
                    transactionsLoading ||
                    filteredTransactions.length === 0
                  }
                  className="rounded-lg border border-cyan-500/50 px-3 py-2 text-sm font-medium text-cyan-300 transition hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Auto-Categorize
                </button>

                <button
                  type="button"
                  onClick={exportTransactionsToCsv}
                  disabled={filteredTransactions.length === 0}
                  className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-emerald-400 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Export CSV
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-800">
                <thead className="bg-slate-950/60">
                  <tr>
                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Date
                    </th>

                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Merchant
                    </th>

                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Account
                    </th>

                    <th className="whitespace-nowrap px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Category
                    </th>

                    <th className="whitespace-nowrap px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Amount
                    </th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {transactionsLoading ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-5 py-12 text-center text-sm text-slate-400"
                      >
                        Loading transactions...
                      </td>
                    </tr>
                  ) : filteredTransactions.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="px-5 py-12 text-center text-sm text-slate-400"
                      >
                        No transactions found for this client and filter
                        selection.
                      </td>
                    </tr>
                  ) : (
                    filteredTransactions.map((transaction) => {
                      const category =
                        getTransactionCategory(transaction);
                      const isEditing =
                        editingCategoryId === transaction.id;
                      const isSaving =
                        savingCategoryId === transaction.id;

                      return (
                        <tr
                          key={transaction.id}
                          className="transition hover:bg-slate-800/40"
                        >
                          <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-300">
                            {formatDate(transaction.date)}
                          </td>

                          <td className="px-5 py-4">
                            <div className="min-w-[180px]">
                              <p className="font-medium text-white">
                                {getMerchantName(transaction)}
                              </p>

                              {transaction.pending && (
                                <span className="mt-1 inline-flex rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-300">
                                  Pending
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="px-5 py-4 text-sm text-slate-400">
                            <div className="min-w-[140px]">
                              <p>
                                {transaction.account_name ||
                                  'Unknown account'}
                              </p>

                              {transaction.account_mask && (
                                <p className="mt-1 text-xs text-slate-500">
                                  •••• {transaction.account_mask}
                                </p>
                              )}
                            </div>
                          </td>

                          <td className="px-5 py-4">
                            {isEditing ? (
                              <select
                                value={category}
                                disabled={isSaving}
                                onChange={(event) =>
                                  handleCategoryChange(
                                    transaction.id,
                                    event.target.value,
                                  )
                                }
                                onBlur={() =>
                                  setEditingCategoryId(null)
                                }
                                autoFocus
                                className="rounded-lg border border-cyan-400 bg-slate-950 px-2 py-1.5 text-sm text-white outline-none"
                              >
                                {CATEGORY_OPTIONS.map(
                                  (categoryOption) => (
                                    <option
                                      key={categoryOption}
                                      value={categoryOption}
                                    >
                                      {categoryOption}
                                    </option>
                                  ),
                                )}
                              </select>
                            ) : (
                              <button
                                type="button"
                                onClick={() =>
                                  setEditingCategoryId(
                                    transaction.id,
                                  )
                                }
                                className="rounded-full bg-slate-800 px-3 py-1 text-left text-xs text-slate-300 transition hover:bg-cyan-500/10 hover:text-cyan-300"
                              >
                                {category}
                              </button>
                            )}
                          </td>

                          <td className="whitespace-nowrap px-5 py-4 text-right text-sm font-semibold text-white">
                            {formatCurrency(
                              Number(transaction.amount || 0),
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-6">
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-white">
                    Merchant Summary
                  </h2>

                  <p className="mt-1 text-sm text-slate-400">
                    Spending grouped by merchant
                  </p>
                </div>
              </div>

              <div className="mt-5 space-y-4">
                {merchantSummary.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No merchant data available.
                  </p>
                ) : (
                  merchantSummary.slice(0, 8).map((merchant) => (
                    <div key={merchant.merchant}>
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-medium text-slate-200">
                          {merchant.merchant}
                        </p>

                        <p className="whitespace-nowrap text-sm font-semibold text-white">
                          {formatCurrency(merchant.total)}
                        </p>
                      </div>

                      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
                        <span>
                          {merchant.count} transaction
                          {merchant.count === 1 ? '' : 's'}
                        </span>

                        <span>
                          {totalSpending > 0
                            ? `${(
                                (merchant.total / totalSpending) *
                                100
                              ).toFixed(1)}%`
                            : '0%'}
                        </span>
                      </div>

                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-cyan-400"
                          style={{
                            width:
                              totalSpending > 0
                                ? `${Math.min(
                                    (merchant.total / totalSpending) *
                                      100,
                                    100,
                                  )}%`
                                : '0%',
                          }}
                        />
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="text-lg font-semibold text-white">
                Category Summary
              </h2>

              <p className="mt-1 text-sm text-slate-400">
                Spending grouped by category
              </p>

              <div className="mt-5 space-y-3">
                {categorySummary.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No category data available.
                  </p>
                ) : (
                  categorySummary.map((item) => (
                    <div
                      key={item.category}
                      className="flex items-center justify-between gap-3"
                    >
                      <p className="text-sm text-slate-300">
                        {item.category}
                      </p>

                      <p className="text-sm font-semibold text-white">
                        {formatCurrency(item.total)}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}