// components/QueryBar.tsx
// Search bar used by the dashboard.

'use client';

import type { ChangeEvent } from 'react';

interface QueryBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function QueryBar({
  value,
  onChange,
  placeholder = 'Search...',
}: QueryBarProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onChange(event.target.value);
  }

  return (
    <div className="relative w-full">
      <input
        type="search"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label="Search dashboard"
        className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400"
      />
    </div>
  );
}