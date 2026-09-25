export interface FinancialCategory {
  name?: string | null;
}

export interface FinancialTransaction {
  amount: number | string | null;
  posted_date?: string | null;
  date?: string | null;
  merchant_name?: string | null;
  name?: string | null;
  category?: string | null;
  canonical_category?: FinancialCategory | null;
}

export interface DateRange {
  start: string;
  end: string;
}

export interface MerchantSpend {
  merchant: string;
  total: number;
  count: number;
}

const NON_SPENDING_CATEGORY_NAMES = new Set([
  'bank transfers',
  'credit card payments',
  'income',
  'owner contributions',
  'owner draws & distributions',
]);

function normalizeCategory(category: string | null | undefined) {
  return (category || '').trim().toLowerCase();
}

export function getTransactionDate(transaction: FinancialTransaction) {
  return transaction.posted_date || transaction.date || '';
}

export function getMerchantName(transaction: FinancialTransaction) {
  return (
    transaction.merchant_name ||
    transaction.name ||
    'Unknown merchant'
  );
}

export function getTransactionCategory(transaction: FinancialTransaction) {
  return (
    transaction.canonical_category?.name ||
    transaction.category ||
    'Uncategorized'
  );
}

function isNonSpendingCategory(category: string) {
  if (NON_SPENDING_CATEGORY_NAMES.has(category)) {
    return true;
  }

  return (
    category.includes('income') ||
    category.includes('revenue') ||
    category.includes('sales') ||
    category.includes('transfer') ||
    category.includes('owner draw') ||
    category.includes('owner contribution') ||
    category.includes('credit card payment')
  );
}

export function isQualifyingSpending(
  transaction: FinancialTransaction,
) {
  const amount = Number(transaction.amount || 0);

  return (
    Number.isFinite(amount) &&
    amount > 0 &&
    !isNonSpendingCategory(
      normalizeCategory(getTransactionCategory(transaction)),
    )
  );
}

function toDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getCurrentMonthRange(referenceDate = new Date()): DateRange {
  return {
    start: toDateString(
      new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1),
    ),
    end: toDateString(
      new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 1),
    ),
  };
}

export function getPreviousMonthRange(referenceDate = new Date()): DateRange {
  return {
    start: toDateString(
      new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 1, 1),
    ),
    end: toDateString(
      new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1),
    ),
  };
}

export function isInDateRange(
  transaction: FinancialTransaction,
  range: DateRange,
) {
  const date = getTransactionDate(transaction);

  return date >= range.start && date < range.end;
}

export function getQualifyingSpendingTransactions(
  transactions: FinancialTransaction[],
  range?: DateRange,
) {
  return transactions.filter(
    (transaction) =>
      isQualifyingSpending(transaction) &&
      (!range || isInDateRange(transaction, range)),
  );
}

export function sumTransactionAmounts(
  transactions: FinancialTransaction[],
) {
  return transactions.reduce(
    (total, transaction) => total + Number(transaction.amount || 0),
    0,
  );
}

export function getFoodDiningSpending(
  transactions: FinancialTransaction[],
  range: DateRange,
) {
  return getQualifyingSpendingTransactions(transactions, range).filter(
    (transaction) =>
      normalizeCategory(getTransactionCategory(transaction)) ===
      'food & dining',
  );
}

export function getTransactionsOverAmount(
  transactions: FinancialTransaction[],
  amount: number,
) {
  return getQualifyingSpendingTransactions(transactions).filter(
    (transaction) => Number(transaction.amount || 0) > amount,
  );
}

export function getTopMerchantSpending(
  transactions: FinancialTransaction[],
  limit = 5,
) {
  const merchantTotals = new Map<string, MerchantSpend>();

  getQualifyingSpendingTransactions(transactions).forEach((transaction) => {
    const merchant = getMerchantName(transaction);
    const current = merchantTotals.get(merchant);
    const amount = Number(transaction.amount || 0);

    if (current) {
      current.total += amount;
      current.count += 1;
      return;
    }

    merchantTotals.set(merchant, {
      merchant,
      total: amount,
      count: 1,
    });
  });

  return Array.from(merchantTotals.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}
