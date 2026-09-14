// components/QueryBar.tsx
// Floating natural language query bar.
// Also supports dashboard transaction searching.

'use client';

import { useState, type ChangeEvent, type KeyboardEvent } from 'react';

interface QueryBarProps {
  clientId?: string;
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
}

interface QueryResult {
  [key: string]: any;
}

const EXAMPLE_QUERIES = [
  'How much did I spend on Food & Dining last month?',
  'Show me all transactions over $50',
  'What are my top 5 merchants by total spend?',
  'How much did I spend in total this month?',
];

export function QueryBar({
  clientId,
  value,
  onChange,
  placeholder,
}: QueryBarProps) {
  const isDashboardSearch =
    typeof value === 'string' && typeof onChange === 'function';

  const [question, setQuestion] = useState(value || '');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  const currentValue = isDashboardSearch ? value : question;

  function updateValue(nextValue: string) {
    if (isDashboardSearch && onChange) {
      onChange(nextValue);
    } else {
      setQuestion(nextValue);
    }
  }

  async function handleQuery(query?: string) {
    const queryText = query ?? currentValue;

    if (!queryText.trim()) {
      return;
    }

    /*
     * In dashboard search mode, the dashboard itself handles filtering.
     * We only update the parent search state and do not call the API.
     */
    if (isDashboardSearch) {
      onChange?.(queryText);
      return;
    }

    if (!clientId) {
      setError('No client was selected for this query.');
      return;
    }

    setLoading(true);
    setError(null);
    setResults(null);
    setSql(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          question: queryText,
          clientId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Query failed');
      }

      setResults(data.results || []);
      setSql(data.sql || null);

      if (query) {
        setQuestion(query);
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to process query.');
    } finally {
      setLoading(false);
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    updateValue(event.target.value);
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      handleQuery();
    }
  }

  const columns =
    results && results.length > 0 ? Object.keys(results[0]) : [];

  return (
    <div
      className="w-full rounded-xl border border-slate-700 bg-slate-950/80 p-3 shadow-inner"
    >
      <div className="flex items-center gap-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-300">
          <span className="text-base">🔍</span>
        </div>

        <div className="min-w-0 flex-1">
          <input
            type={isDashboardSearch ? 'search' : 'text'}
            value={currentValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            placeholder={
              placeholder ||
              'e.g. "How much did I spend on software last month?"'
            }
            aria-label={
              isDashboardSearch
                ? 'Search transactions'
                : 'Ask a financial question'
            }
            className="w-full bg-transparent px-1 py-2 text-sm text-white outline-none placeholder:text-slate-500"
          />
        </div>

        {!isDashboardSearch && (
          <button
            type="button"
            onClick={() => handleQuery()}
            disabled={loading || !currentValue.trim()}
            className="shrink-0 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {loading ? 'Thinking…' : 'Ask'}
          </button>
        )}
      </div>

      {!isDashboardSearch && !results && !loading && (
        <div className="mt-3 border-t border-slate-800 pt-3">
          <p className="mb-2 text-xs font-medium text-slate-500">
            Try asking:
          </p>

          <div className="flex flex-wrap gap-2">
            {EXAMPLE_QUERIES.map((query) => (
              <button
                key={query}
                type="button"
                onClick={() => handleQuery(query)}
                className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-left text-xs text-slate-400 transition hover:border-cyan-500/50 hover:bg-cyan-500/10 hover:text-cyan-300"
              >
                {query}
              </button>
            ))}
          </div>
        </div>
      )}

      {!isDashboardSearch && error && (
        <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          ⚠ {error}
        </div>
      )}

      {!isDashboardSearch && results && (
        <div className="mt-4 border-t border-slate-800 pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">
              {results.length} result{results.length !== 1 ? 's' : ''}
            </span>

            {sql && (
              <button
                type="button"
                onClick={() => setShowSql((current) => !current)}
                className="text-xs text-slate-500 transition hover:text-cyan-300"
              >
                {showSql ? 'Hide SQL' : 'Show SQL'}
              </button>
            )}
          </div>

          {showSql && sql && (
            <pre className="mb-4 max-h-64 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs text-slate-400">
              {sql}
            </pre>
          )}

          {results.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-6 text-center text-sm text-slate-500">
              No results found.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="min-w-full divide-y divide-slate-800 text-sm">
                <thead className="bg-slate-900">
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column}
                        className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                      >
                        {column.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800 bg-slate-950/50">
                  {results.map((row, index) => (
                    <tr
                      key={index}
                      className="transition hover:bg-slate-900"
                    >
                      {columns.map((column) => {
                        const cellValue = row[column];

                        return (
                          <td
                            key={column}
                            className="whitespace-nowrap px-4 py-3 text-slate-300"
                          >
                            {typeof cellValue === 'number'
                              ? column.includes('amount') ||
                                column.includes('total') ||
                                column.includes('sum')
                                ? `$${Number(cellValue).toFixed(2)}`
                                : cellValue
                              : String(cellValue ?? '—')}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}