'use client';

import Link from 'next/link';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

interface CreatedClient {
  id: string;
  firm_id: string;
  business_name: string;
  entity_type: string | null;
  fiscal_year_start: string | null;
  status: string;
  created_at: string;
}

export default function NewClientPage() {
  const router = useRouter();

  const [businessName, setBusinessName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedName = businessName.trim();

    if (!trimmedName) {
      setError('Enter the client’s business name.');
      return;
    }

    if (trimmedName.length > 200) {
      setError('Business name must be 200 characters or fewer.');
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const response = await fetch('/api/clients', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          businessName: trimmedName,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          data?.error || 'Unable to create client.',
        );
      }

      const client = data?.client as CreatedClient | undefined;

      if (!client?.id) {
        throw new Error(
          'Client was created, but the server did not return a client ID.',
        );
      }

      /*
       * Return to the dashboard after creation.
       *
       * The dashboard already loads clients from the database,
       * so the newly created client will become available there.
       *
       * We include clientId in the URL so the dashboard can
       * support explicit client selection as onboarding evolves.
       */
      router.push(
        `/dashboard?clientId=${encodeURIComponent(client.id)}`,
      );
      router.refresh();
    } catch (err) {
      console.error('[new-client] Creation failed:', err);

      setError(
        err instanceof Error
          ? err.message
          : 'Unable to create client.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main
      className="min-h-screen bg-slate-950 px-4 py-8 text-white sm:px-6 lg:px-8"
    >
      <div className="mx-auto max-w-2xl">
        <div className="mb-6">
          <Link
            href="/dashboard"
            className="inline-flex items-center text-sm text-slate-400 transition hover:text-white"
          >
            ← Back to dashboard
          </Link>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl shadow-black/20">
          <div className="border-b border-slate-800 px-6 py-6 sm:px-8">
            <div className="mb-2 text-sm font-semibold text-cyan-400">
              LedgerAI
            </div>

            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
              Add a client
            </h1>

            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
              Create the business profile first. Once it’s created,
              you’ll be able to securely connect that client’s bank
              accounts and begin reviewing transactions.
            </p>
          </div>

          <form
            onSubmit={handleSubmit}
            className="space-y-6 px-6 py-7 sm:px-8"
          >
            <div>
              <label
                htmlFor="businessName"
                className="mb-2 block text-sm font-semibold text-slate-200"
              >
                Business name
              </label>

              <input
                id="businessName"
                name="businessName"
                type="text"
                value={businessName}
                onChange={(event) => {
                  setBusinessName(event.target.value);

                  if (error) {
                    setError('');
                  }
                }}
                placeholder="e.g. Acme Corp"
                autoComplete="organization"
                autoFocus
                maxLength={200}
                disabled={isSubmitting}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-base text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-60"
              />

              <div className="mt-2 text-xs text-slate-500">
                This is the name your bookkeeping team will see
                throughout LedgerAI.
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              >
                {error}
              </div>
            )}

            <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="text-sm font-semibold text-slate-200">
                What happens next?
              </div>

              <p className="mt-1 text-sm leading-6 text-slate-400">
                LedgerAI will securely add this client to your firm.
                Bank connections and transaction data remain isolated
                to the correct client.
              </p>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-slate-800 pt-6 sm:flex-row sm:justify-end">
              <Link
                href="/dashboard"
                className="inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 px-5 py-2.5 text-sm font-semibold text-slate-300 transition hover:border-slate-600 hover:bg-slate-800 hover:text-white"
              >
                Cancel
              </Link>

              <button
                type="submit"
                disabled={isSubmitting || !businessName.trim()}
                className="inline-flex min-h-11 items-center justify-center rounded-xl bg-cyan-500 px-5 py-2.5 text-sm font-bold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {isSubmitting
                  ? 'Creating client...'
                  : 'Create client'}
              </button>
            </div>
          </form>
        </section>

        <p className="mt-5 text-center text-xs leading-5 text-slate-600">
          Client ownership is determined securely from your
          authenticated LedgerAI firm membership.
        </p>
      </div>
    </main>
  );
}