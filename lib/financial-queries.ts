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
  raw_plaid_category?: string | null;
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
    transaction.raw_plaid_category ||
    transaction.category ||
    'Uncategorized'
  );
}

function normalizeCategoryQuestionText(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const USER_CATEGORY_ALIASES = new Map<string, string>([
  ['meals and entertainment', 'food and dining'],
  ['food and dining', 'food and dining'],
  ['travel', 'travel'],
]);

const PLAID_CATEGORY_ALIASES = new Map<string, string>([
  ['food and drink restaurants', 'food and dining'],
  ['food and drink restaurants coffee shop', 'food and dining'],
  ['food and drink restaurants fast food', 'food and dining'],
  ['travel airlines and aviation services', 'travel'],
  ['travel taxi', 'travel'],
]);

const CATEGORY_FAMILY_LABELS = new Map<string, string>([
  ['food and dining', 'Meals & Entertainment'],
  ['travel', 'Travel'],
]);

function normalizeUserCategory(category: string) {
  const normalizedCategory = normalizeCategoryQuestionText(category);

  return USER_CATEGORY_ALIASES.get(normalizedCategory) || normalizedCategory;
}

function getTransactionCategoryKey(transaction: FinancialTransaction) {
  const canonicalCategory = transaction.canonical_category?.name?.trim();

  if (canonicalCategory) {
    return normalizeUserCategory(canonicalCategory);
  }

  const rawCategory = transaction.raw_plaid_category?.trim();

  if (!rawCategory) {
    return null;
  }

  return PLAID_CATEGORY_ALIASES.get(
    normalizeCategoryQuestionText(rawCategory),
  ) || null;
}

export function getCategorySpendIntent(
  question: string,
  transactions: FinancialTransaction[],
) {
  const normalizedQuestion = normalizeCategoryQuestionText(question);
  const match = normalizedQuestion.match(
    /\b(?:spend|spent|spending)\b.*?\bon\s+(.+?)\s+(last month|this month)\b/,
  );

  if (!match) {
    return null;
  }

  const categories = new Map<string, string>();

  for (const transaction of transactions) {
    const categoryKey = getTransactionCategoryKey(transaction);

    if (categoryKey && !categories.has(categoryKey)) {
      const canonicalCategory = transaction.canonical_category?.name?.trim();
      categories.set(
        categoryKey,
        canonicalCategory || CATEGORY_FAMILY_LABELS.get(categoryKey) || categoryKey,
      );
    }
  }

  const requestedCategoryKey = normalizeUserCategory(match[1]);
  const category = categories.get(requestedCategoryKey);

  if (!category) {
    return null;
  }

  return {
    category,
    period: match[2] === 'last month' ? 'last-month' : 'this-month',
  } as const;
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
  return getCategorySpending(transactions, 'Food & Dining', range);
}

export function getCategorySpending(
  transactions: FinancialTransaction[],
  category: string,
  range: DateRange,
) {
  const normalizedCategory = normalizeUserCategory(category);

  return getQualifyingSpendingTransactions(transactions, range).filter(
    (transaction) =>
      getTransactionCategoryKey(transaction) ===
      normalizedCategory,
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
