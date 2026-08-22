// components/QueryBar.tsx
// Floating natural language query bar.
// Type any financial question in plain English — Claude converts it
// to SQL, runs it, and shows the results instantly in a table.

'use client';

import { useState } from 'react';

interface QueryBarProps {
  clientId: string;
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

export function QueryBar({ clientId }: QueryBarProps) {
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<QueryResult[] | null>(null);
  const [sql, setSql] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);

  async function handleQuery(q?: string) {
    const queryText = q || question;
    if (!queryText.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setSql(null);

    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: queryText, clientId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Query failed');
      setResults(data.results);
      setSql(data.sql);
      if (q) setQuestion(q);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const columns = results && results.length > 0 ? Object.keys(results[0]) : [];

  return (
    <div style={{
      background: '#1e293b',
      borderRadius: 12,
      padding: 20,
      marginBottom: 24,
      border: '1px solid #334155',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>🔍</span>
        <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
          Ask anything about your finances
        </span>
      </div>

      {/* Input row */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleQuery()}
          placeholder='e.g. "How much did I spend on software last month?"'
          style={{
            flex: 1,
            padding: '10px 14px',
            borderRadius: 8,
            border: '1px solid #475569',
            background: '#0f172a',
            color: '#f1f5f9',
            fontSize: 14,
            outline: 'none',
          }}
        />
        <button
          onClick={() => handleQuery()}
          disabled={loading || !question.trim()}
          style={{
            padding: '10px 20px',
            borderRadius: 8,
            border: 'none',
            background: loading ? '#475569' : '#3b82f6',
            color: 'white',
            fontWeight: 600,
            fontSize: 13,
            cursor: loading ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {loading ? 'Thinking…' : 'Ask'}
        </button>
      </div>

      {/* Example queries */}
      {!results && !loading && (
        <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {EXAMPLE_QUERIES.map((q) => (
            <button
              key={q}
              onClick={() => handleQuery(q)}
              style={{
                padding: '4px 10px',
                borderRadius: 20,
                border: '1px solid #334155',
                background: 'transparent',
                color: '#64748b',
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ marginTop: 12, color: '#f87171', fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      {/* Results */}
      {results && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ color: '#94a3b8', fontSize: 12 }}>
              {results.length} result{results.length !== 1 ? 's' : ''}
            </span>
            <button
              onClick={() => setShowSql(!showSql)}
              style={{ background: 'none', border: 'none', color: '#475569', fontSize: 11, cursor: 'pointer' }}
            >
              {showSql ? 'Hide SQL' : 'Show SQL'}
            </button>
          </div>

          {showSql && sql && (
            <pre style={{
              background: '#0f172a',
              padding: 10,
              borderRadius: 6,
              fontSize: 11,
              color: '#94a3b8',
              overflowX: 'auto',
              marginBottom: 10,
            }}>
              {sql}
            </pre>
          )}

          {results.length === 0 ? (
            <div style={{ color: '#64748b', fontSize: 13 }}>No results found.</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr>
                    {columns.map((col) => (
                      <th key={col} style={{
                        textAlign: 'left',
                        padding: '6px 10px',
                        color: '#64748b',
                        fontWeight: 600,
                        fontSize: 11,
                        textTransform: 'uppercase',
                        borderBottom: '1px solid #334155',
                      }}>
                        {col.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.map((row, i) => (
                    <tr key={i}>
                      {columns.map((col) => (
                        <td key={col} style={{
                          padding: '8px 10px',
                          color: '#e2e8f0',
                          borderBottom: '1px solid #1e293b',
                        }}>
                          {typeof row[col] === 'number'
                            ? col.includes('amount') || col.includes('total') || col.includes('sum')
                              ? `$${Number(row[col]).toFixed(2)}`
                              : row[col]
                            : String(row[col] ?? '—')}
                        </td>
                      ))}
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
