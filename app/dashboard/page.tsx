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
import ConnectedBanksPanel from '@/components/ConnectedBanksPanel';
import {
  getCurrentMonthRange,
  getFoodDiningSpending,
  getMerchantName,
  getPreviousMonthRange,
  getQualifyingSpendingTransactions,
  getTopMerchantSpending,
  getTransactionCategory,
  getTransactionDate,
  getTransactionsOverAmount,
  isQualifyingSpending,
  sumTransactionAmounts,
} from '@/lib/financial-queries';

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

interface ReauthenticationRequiredItem {
  plaid_item_database_id: string;
  plaid_item_id: string;
  institution_name?: string | null;
}

const SUGGESTED_QUESTIONS = [
  'How much did I spend on Meals & Entertainment last month?',
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
  const [connectionsRefreshKey, setConnectionsRefreshKey] = useState(0);

  const [loading, setLoading] = useState(true);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [reauthenticationRequired, setReauthenticationRequired] = useState<
    ReauthenticationRequiredItem[]
  >([]);

  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [timeframe, setTimeframe] = useState('all');

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

        const requestedClientId = new URLSearchParams(
          window.location.search,
        ).get('clientId');

        const requestedClient = requestedClientId
          ? loadedClients.find(
              (client) => client.id === requestedClientId,
            )
          : null;

        const acmeClient = loadedClients.find(
          (client) =>
            client.name.toLowerCase().trim() === 'acme corp',
        );

        const initialClient =
          requestedClient || acmeClient || loadedClients[0];

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
    return filteredTransactions.filter(isQualifyingSpending);
  }, [filteredTransactions]);

  const totalSpending = useMemo(() => {
    return sumTransactionAmounts(spendingTransactions);
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
    return getTopMerchantSpending(spendingTransactions, Number.MAX_SAFE_INTEGER);
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
    setReauthenticationRequired([]);
    setSearchTerm('');
    setCategoryFilter('All Categories');
    setAccountFilter('All Accounts');
    setStartDate('');
    setEndDate('');
    setTimeframe('all');
    setFinanceQuestion('');
    setAskAnswer('');
    setSuccessMessage('');
    setErrorMessage('');
  }

  function handleTimeframeChange(
    event: ChangeEvent<HTMLSelectElement>,
  ) {
    const nextTimeframe = event.target.value;
    setTimeframe(nextTimeframe);

    if (nextTimeframe === 'all') {
      setStartDate('');
      setEndDate('');
      return;
    }

    const today = new Date();
    const toDateInputValue = (date: Date) => {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };

    if (nextTimeframe === 'this-month') {
      const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
      setStartDate(toDateInputValue(firstDay));
      setEndDate(toDateInputValue(today));
      return;
    }

    if (nextTimeframe === 'last-30-days') {
      const firstDay = new Date(today);
      firstDay.setDate(today.getDate() - 29);
      setStartDate(toDateInputValue(firstDay));
      setEndDate(toDateInputValue(today));
      return;
    }

    if (nextTimeframe === 'custom') {
      return;
    }
  }

  function clearFilters() {
    setSearchTerm('');
    setCategoryFilter('All Categories');
    setAccountFilter('All Accounts');
    setStartDate('');
    setEndDate('');
    setTimeframe('all');
  }

  async function refreshTransactions() {
    if (!selectedClientId) {
      return;
    }

    try {
      setTransactionsLoading(true);
      setErrorMessage('');
      setSuccessMessage('');
      setReauthenticationRequired([]);

      const syncResponse = await fetch('/api/plaid/sync', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: selectedClientId,
        }),
      });

      const syncResult = await syncResponse.json().catch(() => ({}));

      if (!syncResponse.ok && syncResponse.status !== 207) {
        throw new Error(
          syncResult?.error || 'Unable to synchronize transactions with Plaid.',
        );
      }

      setConnectionsRefreshKey((currentKey) => currentKey + 1);

      const requiredItems = Array.isArray(
        syncResult?.reauthentication_required,
      )
        ? (syncResult.reauthentication_required as ReauthenticationRequiredItem[])
        : [];

      const itemFailures = Array.isArray(syncResult?.item_failures)
        ? syncResult.item_failures
        : [];

      setReauthenticationRequired(requiredItems);

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

      if (itemFailures.length > 0) {
        setErrorMessage(
          `${itemFailures.length} bank connection${
            itemFailures.length === 1 ? '' : 's'
          } could not synchronize. Existing transaction data was preserved.`,
        );
      }

      if (requiredItems.length > 0) {
        setSuccessMessage(
          `${syncResult.successful_items || 0} bank connection${
            syncResult.successful_items === 1 ? '' : 's'
          } synchronized. ${requiredItems.length} require${
            requiredItems.length === 1 ? 's' : ''
          } reauthentication.`,
        );
      } else if (itemFailures.length === 0) {
        setSuccessMessage('Bank transactions synchronized and refreshed successfully.');
      }
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

  async function handleBankReconnected() {
    await refreshTransactions();
    setSuccessMessage('Bank connection repaired and transactions refreshed successfully.');
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

    if (
      normalizedQuestion.includes('food') &&
      normalizedQuestion.includes('dining') &&
      normalizedQuestion.includes('last month')
    ) {
      const total = sumTransactionAmounts(
        getFoodDiningSpending(
          transactions,
          getPreviousMonthRange(),
        ),
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
      const matchingTransactions = getTransactionsOverAmount(
        transactions,
        50,
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
      const topMerchants = getTopMerchantSpending(transactions)
        .map(
          (merchant, index) =>
            `${index + 1}. ${merchant.merchant} — ${formatCurrency(
              merchant.total,
            )}`,
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
      const total = sumTransactionAmounts(
        getQualifyingSpendingTransactions(
          transactions,
          getCurrentMonthRange(),
        ),
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
        <header className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-xl">
          <div className="flex flex-col gap-6 border-b border-slate-800 px-5 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <div
                className="relative flex shrink-0 items-center justify-center"
                style={{
                  width: 50,
                  height: 50,
                  borderRadius: 14,
                  background:
                    'linear-gradient(135deg,#0b1329 0%,#030712 100%)',
                  boxShadow:
                    '0 0 22px rgba(56,189,248,0.4), inset 0 0 10px rgba(129,140,248,0.2)',
                  border: '1.5px solid rgba(56,189,248,0.6)',
                }}
              >
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 32 32"
                  fill="none"
                  aria-hidden="true"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <defs>
                    <linearGradient
                      id="ledgerai-mark"
                      x1="0"
                      y1="0"
                      x2="32"
                      y2="32"
                      gradientUnits="userSpaceOnUse"
                    >
                      <stop stopColor="#38bdf8" />
                      <stop offset="0.5" stopColor="#818cf8" />
                      <stop offset="1" stopColor="#c084fc" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M16 3L28 9.5V22.5L16 29L4 22.5V9.5L16 3Z"
                    stroke="url(#ledgerai-mark)"
                    strokeWidth="2"
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
                <div className="flex flex-wrap items-center gap-2.5">
                  <h1 className="text-2xl font-extrabold tracking-[-0.03em] text-white sm:text-3xl">
                    Ledger<span className="text-cyan-400">AI</span>
                  </h1>
                  <span className="rounded-md border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
                    Enterprise
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-400">
                  Smarter financial insights. Clearer decisions.
                </p>
              </div>
            </div>

            <div className="flex flex-col items-start gap-2 lg:items-end">
              {userEmail && (
                <p className="text-xs text-slate-500">{userEmail}</p>
              )}
              <button
                type="button"
                onClick={handleSignOut}
                className="rounded-lg border border-slate-700 px-3.5 py-2 text-sm font-medium text-slate-300 transition hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-300"
              >
                Sign out
              </button>
            </div>
          </div>

          <div className="grid gap-4 px-5 py-5 sm:px-6 xl:grid-cols-[minmax(260px,1.2fr)_minmax(190px,0.7fr)_auto] xl:items-end">
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label
                  htmlFor="client"
                  className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"
                >
                  Active Client
                </label>
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = '/clients/new';
                  }}
                  className="text-xs font-semibold text-cyan-400 transition hover:text-cyan-300"
                >
                  + Add Client
                </button>
              </div>

              <select
                id="client"
                value={selectedClientId}
                onChange={handleClientChange}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-semibold text-white outline-none transition focus:border-cyan-400"
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
            </div>

            <div>
              <label
                htmlFor="timeframe"
                className="mb-2 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"
              >
                Timeframe
              </label>
              <select
                id="timeframe"
                value={timeframe}
                onChange={handleTimeframeChange}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-sm font-semibold text-white outline-none transition focus:border-cyan-400"
              >
                <option value="all">All Time</option>
                <option value="this-month">This Month</option>
                <option value="last-30-days">Last 30 Days</option>
                <option value="custom">Custom Range</option>
              </select>
            </div>

            <div className="flex flex-wrap gap-2 xl:justify-end">
              <PlaidLinkButton
                selectedClientId={selectedClientId}
                onBankConnected={handleBankConnected}
              />

              <button
                type="button"
                onClick={refreshTransactions}
                disabled={transactionsLoading || !selectedClientId}
                className="rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-cyan-400 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {transactionsLoading ? 'Refreshing...' : 'Refresh'}
              </button>

              <button
                type="button"
                onClick={exportTransactionsToCsv}
                disabled={filteredTransactions.length === 0}
                className="rounded-xl border border-slate-700 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:border-emerald-400 hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Export CSV
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-950/30 px-5 py-3 text-xs text-slate-500 sm:px-6">
            <span>
              {selectedClient
                ? `Viewing ${selectedClient.name}`
                : 'Select a client workspace'}
            </span>
            <span>
              {memberships.length} connected firm{memberships.length === 1 ? '' : 's'}
            </span>
          </div>
        </header>

        {selectedClientId && (
          <ConnectedBanksPanel
            clientId={selectedClientId}
            refreshKey={connectionsRefreshKey}
          />
        )}

        {errorMessage && (
          <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {errorMessage}
          </div>
        )}

        {reauthenticationRequired.length > 0 && (
          <section className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-4 text-sm text-amber-100">
            <div className="font-semibold">
              Bank connection{reauthenticationRequired.length === 1 ? '' : 's'} require reauthentication
            </div>
            <p className="mt-1 text-amber-200/80">
              Existing transactions are still available. Reconnect each affected bank to resume synchronization.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {reauthenticationRequired.map((item) => (
                <PlaidLinkButton
                  key={item.plaid_item_database_id}
                  selectedClientId={selectedClientId}
                  reconnectItemId={item.plaid_item_database_id}
                  reconnectLabel={`Fix ${
                    item.institution_name || 'bank connection'
                  }`}
                  onReconnected={handleBankReconnected}
                />
              ))}
            </div>
          </section>
        )}

        {successMessage && (
          <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
            {successMessage}
          </div>
        )}

        {selectedClient &&
          !transactionsLoading &&
          transactions.length === 0 && (
            <section className="rounded-2xl border border-cyan-500/20 bg-slate-900 p-6 shadow-xl sm:p-8">
              <div className="mx-auto max-w-2xl text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/10 text-xl">
                  🏦
                </div>

                <p className="mt-5 text-sm font-semibold text-cyan-400">
                  Client workspace ready
                </p>

                <h2 className="mt-2 text-2xl font-bold tracking-tight text-white">
                  Connect {selectedClient.name}&apos;s first bank account
                </h2>

                <p className="mx-auto mt-3 max-w-xl text-sm leading-6 text-slate-400">
                  This client does not have any transactions yet. Connect a bank
                  account to securely import transaction history and begin
                  categorizing and reviewing the books.
                </p>

                <div className="mt-6 flex justify-center">
                  <PlaidLinkButton
                    selectedClientId={selectedClientId}
                    onBankConnected={handleBankConnected}
                  />
                </div>

                <div className="mt-7 grid gap-3 text-left sm:grid-cols-3">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Step 1
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-200">
                      Connect bank
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Step 2
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-200">
                      Import transactions
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Step 3
                    </p>
                    <p className="mt-2 text-sm font-semibold text-slate-200">
                      Review &amp; categorize
                    </p>
                  </div>
                </div>
              </div>
            </section>
          )}

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
                  onChange={(event) => {
                    setStartDate(event.target.value);
                    setTimeframe('custom');
                  }}
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
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    setTimeframe('custom');
                  }}
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