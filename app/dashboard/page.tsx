'use client';

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from 'react';
import { supabase } from '@/lib/supabase-browser';
import { QueryBar } from '@/components/QueryBar';
import PlaidLinkButton from '@/components/PlaidLinkButton';

interface Transaction {
  id: string;
  user_id?: string | null;
  client_id?: string | null;
  date: string;
  posted_date?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  amount: number;
  category?: string | null;
  ai_category_id?: string | null;
  canonical_category?: {
    id: string;
    name: string;
  } | null;
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

interface Category {
  id: string;
  name: string;
  client_id?: string | null;
  coa_code?: string | null;
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

interface SupabaseClientRecord {
  id: string;
  firm_id: string;
  business_name: string;
}


const SUGGESTED_QUESTIONS = [
  'How much did I spend on Food & Dining last month?',
  'Show me all transactions over $50',
  'What are my top 5 merchants by total spend?',
  'How much did I spend in total this month?',
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

function getTransactionDate(transaction: Transaction) {
  return transaction.posted_date || transaction.date;
}

function getMerchantName(transaction: Transaction) {
  return (
    transaction.merchant_name ||
    transaction.name ||
    'Unknown merchant'
  );
}

function getTransactionCategory(transaction: Transaction) {
  if (transaction.canonical_category?.name) {
    return transaction.canonical_category.name;
  }

  if (transaction.category) {
    return transaction.category;
  }

  if (transaction.personal_finance_category?.primary) {
    return transaction.personal_finance_category.primary;
  }

  return 'Uncategorized';
}

const OPERATING_EXPENSE_CATEGORIES = new Set([
  'advertising & marketing',
  'bank fees',
  'cost of goods sold',
  'contractors',
  'education & training',
  'food & dining',
  'insurance',
  'legal & professional',
  'meals & entertainment',
  'office supplies',
  'other business expenses',
  'payroll',
  'rent & lease',
  'repairs & maintenance',
  'software & subscriptions',
  'taxes & licenses',
  'transportation',
  'travel',
  'utilities',
]);

function isOperatingExpenseTransaction(transaction: Transaction) {
  const amount = Number(transaction.amount || 0);

  if (amount <= 0) {
    return false;
  }

  const category = getTransactionCategory(transaction).toLowerCase().trim();

  return OPERATING_EXPENSE_CATEGORIES.has(category);
}

function escapeCsvValue(
  value: string | number | boolean | null | undefined,
) {
  const stringValue = String(value ?? '');

  return `"${stringValue.replace(/"/g, '""')}"`;
}

function normalizeClients(
  data: SupabaseClientRecord[] | null,
): Client[] {
  return (data ?? [])
    .map((client) => ({
      id: client.id,
      name: client.business_name,
      firm_id: client.firm_id,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export default function DashboardPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  const [clients, setClients] = useState<Client[]>([]);
  const [memberships, setMemberships] = useState<FirmMembership[]>([]);

  const [selectedClientId, setSelectedClientId] = useState<string>('');
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);

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

  const [financeQuestion, setFinanceQuestion] = useState('');
  const [askAnswer, setAskAnswer] = useState('');
  const [isAsking, setIsAsking] = useState(false);

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
            .select('id, firm_id, business_name')
            .in('firm_id', firmIds);

          if (clientError) {
            throw clientError;
          }

          loadedClients = normalizeClients(
            (clientData || []) as SupabaseClientRecord[],
          );
        } else {
          const { data: clientData, error: clientError } = await supabase
            .from('clients')
            .select('id, firm_id, business_name');

          if (clientError) {
            throw clientError;
          }

          loadedClients = normalizeClients(
            (clientData || []) as SupabaseClientRecord[],
          );
        }

        setClients(loadedClients);

        if (loadedClients.length === 0) {
          setSelectedClientId('');
          setTransactions([]);
          return;
        }

        const acmeClient = loadedClients.find(
          (client) => client.name.toLowerCase().trim() === 'acme corp',
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
  }, []);

  useEffect(() => {
    async function loadAvailableCategories() {
      if (!selectedClientId) {
        setCategories([]);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('categories')
          .select('id, name, client_id, coa_code')
          .or(`client_id.eq.${selectedClientId},client_id.is.null`)
          .order('name', { ascending: true });

        if (error) throw error;

        const byName = new Map<string, Category>();

        for (const category of (data || []) as Category[]) {
          const key = category.name.toLowerCase().trim();
          const existing = byName.get(key);

          if (!existing || category.client_id === selectedClientId) {
            byName.set(key, category);
          }
        }

        setCategories(
          Array.from(byName.values()).sort((a, b) =>
            a.name.localeCompare(b.name),
          ),
        );
      } catch (error: any) {
        console.error('Error loading categories:', error);
        setCategories([]);
        setErrorMessage(
          error?.message || 'Unable to load categories for this client.',
        );
      }
    }

    loadAvailableCategories();
  }, [selectedClientId]);

  useEffect(() => {
    async function loadSelectedClientTransactions() {
      if (!selectedClientId) {
        setTransactions([]);
        return;
      }

      try {
        setTransactionsLoading(true);
        setErrorMessage('');

        const { data, error } = await supabase
          .from('transactions')
          .select(`
            *,
            accounts (
              id,
              name,
              mask,
              type,
              subtype
            ),
            canonical_category:categories!transactions_ai_category_id_fkey (
              id,
              name
            )
          `)
          .eq('client_id', selectedClientId)
          .order('posted_date', {
            ascending: false,
          });

        if (error) {
          throw error;
        }

        const formattedTransactions = (data || []).map(
          (transaction: any) => ({
            ...transaction,
            account_name: transaction.accounts?.name || null,
            account_mask: transaction.accounts?.mask || null,
          }),
        );

        setTransactions(formattedTransactions as Transaction[]);
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
  }, [selectedClientId]);

  const selectedClient = useMemo(() => {
    return (
      clients.find((client) => client.id === selectedClientId) || null
    );
  }, [clients, selectedClientId]);

  const accountOptions = useMemo(() => {
    const accounts = transactions
      .map((transaction) => transaction.account_name || 'Unknown account')
      .filter(Boolean);

    return ['All Accounts', ...Array.from(new Set(accounts)).sort()];
  }, [transactions]);

  const categoryOptions = useMemo(() => {
    const categoryNames = [
      ...categories.map((category) => category.name),
      ...transactions.map((transaction) =>
        getTransactionCategory(transaction),
      ),
    ];

    return [
      'All Categories',
      ...Array.from(new Set(categoryNames)).sort(),
    ];
  }, [categories, transactions]);

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
        !startDate || getTransactionDate(transaction) >= startDate;

      const matchesEndDate =
        !endDate || getTransactionDate(transaction) <= endDate;

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

  const spendingTransactions = useMemo(() => {
    return filteredTransactions.filter(isOperatingExpenseTransaction);
  }, [filteredTransactions]);

  const totalSpending = useMemo(() => {
    return spendingTransactions.reduce(
      (total, transaction) => total + Number(transaction.amount || 0),
      0,
    );
  }, [spendingTransactions]);

  const transactionCount = filteredTransactions.length;
  const spendingTransactionCount = spendingTransactions.length;

  const averageTransaction = useMemo(() => {
    if (spendingTransactionCount === 0) {
      return 0;
    }

    return totalSpending / spendingTransactionCount;
  }, [totalSpending, spendingTransactionCount]);

  const merchantSummary = useMemo<GroupedMerchant[]>(() => {
    const merchantMap = new Map<string, GroupedMerchant>();

    spendingTransactions.forEach((transaction) => {
      const merchant = getMerchantName(transaction);
      const current = merchantMap.get(merchant);
      const amount = Number(transaction.amount || 0);

      if (current) {
        current.total += amount;
        current.count += 1;
      } else {
        merchantMap.set(merchant, {
          merchant,
          total: amount,
          count: 1,
        });
      }
    });

    return Array.from(merchantMap.values()).sort(
      (a, b) => b.total - a.total,
    );
  }, [spendingTransactions]);

  const categorySummary = useMemo(() => {
    const categoryMap = new Map<string, number>();

    spendingTransactions.forEach((transaction) => {
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
  }, [spendingTransactions]);

  function handleClientChange(
    event: ChangeEvent<HTMLSelectElement>,
  ) {
    setSelectedClientId(event.target.value);
    setSearchTerm('');
    setCategoryFilter('All Categories');
    setAccountFilter('All Accounts');
    setStartDate('');
    setEndDate('');
    setFinanceQuestion('');
    setAskAnswer('');
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

      const { data, error } = await supabase
        .from('transactions')
        .select(`
          *,
          accounts (
            id,
            name,
            mask,
            type,
            subtype
          ),
          canonical_category:categories!transactions_ai_category_id_fkey (
            id,
            name
          )
        `)
        .eq('client_id', selectedClientId)
        .order('posted_date', {
          ascending: false,
        });

      if (error) {
        throw error;
      }

      const formattedTransactions = (data || []).map(
        (transaction: any) => ({
          ...transaction,
          account_name: transaction.accounts?.name || null,
          account_mask: transaction.accounts?.mask || null,
        }),
      );

      setTransactions(formattedTransactions as Transaction[]);
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

  async function handleBankConnected() {
    await refreshTransactions();
    setSuccessMessage('Bank connected and transactions refreshed successfully.');
  }

  async function handleCategoryChange(
    transactionId: string,
    categoryId: string,
  ) {
    if (!selectedClientId || !categoryId) return;

    try {
      setSavingCategoryId(transactionId);
      setErrorMessage('');
      setSuccessMessage('');

      const response = await fetch('/api/category-correction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transactionId,
          clientId: selectedClientId,
          categoryId,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || 'Unable to update transaction category.',
        );
      }

      setTransactions((currentTransactions) =>
        currentTransactions.map((transaction) =>
          transaction.id === transactionId
            ? {
                ...transaction,
                ai_category_id: result.category.id,
                category: result.category.name,
                canonical_category: {
                  id: result.category.id,
                  name: result.category.name,
                },
              }
            : transaction,
        ),
      );

      setEditingCategoryId(null);
      setSuccessMessage(
        result.unchanged
          ? 'Category is already up to date.'
          : 'Category updated and learning saved successfully.',
      );
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
    if (!selectedClientId) {
      setErrorMessage('Please select a client first.');
      return;
    }

    try {
      setTransactionsLoading(true);
      setErrorMessage('');
      setSuccessMessage('');

      const response = await fetch('/api/categorize-local', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientId: selectedClientId,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(
          result.error || 'Unable to categorize transactions.',
        );
      }

      const { data, error } = await supabase
        .from('transactions')
        .select(`
          *,
          accounts (
            id,
            name,
            mask,
            type,
            subtype
          ),
          canonical_category:categories!transactions_ai_category_id_fkey (
            id,
            name
          )
        `)
        .eq('client_id', selectedClientId)
        .order('posted_date', {
          ascending: false,
        });

      if (error) {
        throw error;
      }

      const formattedTransactions = (data || []).map(
        (transaction: any) => ({
          ...transaction,
          account_name: transaction.accounts?.name || null,
          account_mask: transaction.accounts?.mask || null,
        }),
      );

      setTransactions(formattedTransactions as Transaction[]);

      if (result.categorized > 0) {
        setSuccessMessage(
          `${result.categorized} transaction${
            result.categorized === 1 ? '' : 's'
          } categorized successfully.${
            result.skipped > 0
              ? ` ${result.skipped} left for review.`
              : ''
          }`,
        );
      } else {
        setSuccessMessage(
          result.skipped > 0
            ? `No additional transactions matched the available local rules. ${result.skipped} left for review.`
            : 'There are no transactions waiting for local categorization.',
        );
      }
    } catch (error: any) {
      console.error('Error categorizing transactions:', error);

      setErrorMessage(
        error?.message || 'Unable to categorize transactions.',
      );
    } finally {
      setTransactionsLoading(false);
    }
  }

  function answerFinanceQuestion(question: string) {
    const normalizedQuestion = question.toLowerCase().trim();

    if (!normalizedQuestion) {
      setAskAnswer('Please enter a question about your finances.');
      return;
    }

    if (transactions.length === 0) {
      setAskAnswer(
        'There are no transactions available for this client yet.',
      );
      return;
    }

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    if (
      normalizedQuestion.includes('food') &&
      normalizedQuestion.includes('dining') &&
      normalizedQuestion.includes('last month')
    ) {
      const lastMonthDate = new Date(
        currentYear,
        currentMonth - 1,
        1,
      );

      const lastMonth = lastMonthDate.getMonth();
      const lastMonthYear = lastMonthDate.getFullYear();

      const total = transactions
        .filter((transaction) => {
          const date = new Date(`${getTransactionDate(transaction)}T00:00:00`);
          const category = getTransactionCategory(transaction)
            .toLowerCase();

          return (
            date.getMonth() === lastMonth &&
            date.getFullYear() === lastMonthYear &&
            (category.includes('food') ||
              category.includes('dining'))
          );
        })
        .reduce(
          (sum, transaction) => sum + Number(transaction.amount || 0),
          0,
        );

      setAskAnswer(
        `You spent ${formatCurrency(
          total,
        )} on Food & Dining last month.`,
      );
      return;
    }

    if (
      normalizedQuestion.includes('over $50') ||
      normalizedQuestion.includes('over 50')
    ) {
      const matchingTransactions = transactions.filter(
        (transaction) => Number(transaction.amount || 0) > 50,
      );

      if (matchingTransactions.length === 0) {
        setAskAnswer('There are no transactions over $50.');
        return;
      }

      const transactionText = matchingTransactions
        .slice(0, 10)
        .map(
          (transaction) =>
            `${formatDate(getTransactionDate(transaction))} — ${getMerchantName(
              transaction,
            )} — ${formatCurrency(
              Number(transaction.amount || 0),
            )}`,
        )
        .join('\n');

      const remainingCount = matchingTransactions.length - 10;

      setAskAnswer(
        `I found ${
          matchingTransactions.length
        } transaction${
          matchingTransactions.length === 1 ? '' : 's'
        } over $50:\n\n${transactionText}${
          remainingCount > 0
            ? `\n\n...and ${remainingCount} more.`
            : ''
        }`,
      );
      return;
    }

    if (
      normalizedQuestion.includes('top 5') &&
      normalizedQuestion.includes('merchant')
    ) {
      const merchantTotals = new Map<string, number>();

      transactions.forEach((transaction) => {
        const merchant = getMerchantName(transaction);
        const currentTotal = merchantTotals.get(merchant) || 0;

        merchantTotals.set(
          merchant,
          currentTotal + Number(transaction.amount || 0),
        );
      });

      const topMerchants = Array.from(merchantTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(
          ([merchant, total], index) =>
            `${index + 1}. ${merchant} — ${formatCurrency(total)}`,
        )
        .join('\n');

      setAskAnswer(
        `Your top 5 merchants by total spend are:\n\n${topMerchants}`,
      );
      return;
    }

    if (
      normalizedQuestion.includes('total') &&
      normalizedQuestion.includes('this month')
    ) {
      const total = transactions
        .filter((transaction) => {
          const date = new Date(`${getTransactionDate(transaction)}T00:00:00`);

          return (
            date.getMonth() === currentMonth &&
            date.getFullYear() === currentYear
          );
        })
        .reduce(
          (sum, transaction) => sum + Number(transaction.amount || 0),
          0,
        );

      setAskAnswer(
        `You have spent ${formatCurrency(
          total,
        )} in total this month.`,
      );
      return;
    }

    setAskAnswer(
      'I can currently answer questions about Food & Dining spending, transactions over $50, top merchants, and total spending this month.',
    );
  }

 async function askQuestion(question: string) {
  const trimmedQuestion = question.trim();

  if (!trimmedQuestion) {
    setAskAnswer('Please enter a question about your finances.');
    return;
  }

  if (!selectedClientId) {
    setAskAnswer('Please select a client first.');
    return;
  }

  setIsAsking(true);
  setAskAnswer('');

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question: trimmedQuestion,
        selectedClientId,
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      setAskAnswer(
        result.error || 'Unable to answer your question right now.',
      );
      return;
    }

    setAskAnswer(result.answer || 'No answer was returned.');
  } catch (error) {
    console.error('Ask question error:', error);

    setAskAnswer(
      'Unable to connect to the finance assistant. Please try again.',
    );
  } finally {
    setIsAsking(false);
  }
}

function handleAskQuestion() {
  void askQuestion(financeQuestion);
}

 function handleSuggestedQuestion(question: string) {
  setFinanceQuestion(question);
  void askQuestion(question);
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
      getTransactionDate(transaction),
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
                <PlaidLinkButton
                  selectedClientId={selectedClientId}
                  onBankConnected={handleBankConnected}
                />

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
            <p className="text-sm text-slate-400">
              Average Spend
            </p>

            <p className="mt-2 text-2xl font-bold text-white">
              {formatCurrency(averageTransaction)}
            </p>

            <p className="mt-1 text-xs text-slate-500">
              Average operating expense
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

        <section className="rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-white">
              🔍 Ask anything about your finances
            </h2>

            <p className="mt-1 text-sm text-slate-400">
              Ask a question about your transaction history and spending.
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={financeQuestion}
              onChange={(event) =>
                setFinanceQuestion(event.target.value)
              }
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleAskQuestion();
                }
              }}
              placeholder="Ask a question about your finances..."
              className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-4 py-3 text-sm text-white outline-none placeholder:text-slate-500 focus:border-cyan-400"
            />

            <button
              type="button"
              onClick={handleAskQuestion}
              disabled={isAsking || !financeQuestion.trim()}
              className="rounded-lg bg-cyan-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isAsking ? 'Asking...' : 'Ask'}
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {SUGGESTED_QUESTIONS.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => handleSuggestedQuestion(question)}
                className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-left text-xs text-slate-300 transition hover:border-cyan-400 hover:text-cyan-300"
              >
                {question}
              </button>
            ))}
          </div>

          {askAnswer && (
            <div className="mt-5 whitespace-pre-line rounded-lg border border-slate-700 bg-slate-950/80 p-4 text-sm leading-6 text-slate-200">
              {askAnswer}
            </div>
          )}
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
                            {formatDate(getTransactionDate(transaction))}
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
                                value={transaction.ai_category_id || ''}
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
                                {!transaction.ai_category_id && (
                                  <option value="" disabled>
                                    Select category
                                  </option>
                                )}

                                {categories.map((categoryOption) => (
                                  <option
                                    key={categoryOption.id}
                                    value={categoryOption.id}
                                  >
                                    {categoryOption.coa_code
                                      ? `${categoryOption.coa_code} — ${categoryOption.name}`
                                      : categoryOption.name}
                                  </option>
                                ))}
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