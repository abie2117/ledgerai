# LedgerAI

AI bookkeeping co-pilot for small accounting firms — Plaid for bank data,
Claude for categorization, Supabase for storage/auth, Next.js for the app.

## What's here

```
schema/                  Supabase SQL migrations — run in order (001 → 003)
lib/                      Server-side logic: Plaid sync, Claude categorization,
                          Supabase/auth helpers
components/               React components for the review console and dashboard
app/                      Next.js App Router pages and API routes
docs/PLAID_INTEGRATION.md Design notes for the Plaid sync flow
LedgerAI-Business-Blueprint.docx   Product/business plan
```

## Setup

1. **Install dependencies**
   ```
   npm install
   ```

2. **Create a Supabase project**, then run the migrations in order via the
   SQL editor or `supabase db push`:
   ```
   schema/001_init.sql
   schema/002_encryption.sql
   schema/003_triggers.sql
   ```

3. **Set the Plaid token encryption key** as a Postgres setting (do this in
   the Supabase dashboard/CLI — never commit it to source):
   ```sql
   alter database postgres set app.plaid_token_key = '<a long random secret>';
   ```

4. **Copy `.env.example` to `.env.local`** and fill in:
   - Supabase URL + anon key + service role key (Project Settings → API)
   - Plaid client ID + secret (start with `PLAID_ENV=sandbox`)
   - Anthropic API key

5. **Run it**
   ```
   npm run dev
   ```
   Visit `http://localhost:3000` → redirects to `/signup` if you're not
   logged in yet.

## First run walkthrough

1. Sign up — this creates your firm and your user in one step
   (`/api/auth/signup`).
2. You land on `/dashboard`, empty at first.
3. Click **+ Add client** → creates the client record, then optionally
   connect their bank account via Plaid Link (use Plaid's sandbox test
   credentials while `PLAID_ENV=sandbox`).
4. Once connected, transactions sync in and land on the client's
   `/clients/[clientId]/transactions` page for review.
5. Confirm or correct each one — corrections feed `category_mapping_rules`,
   which is what makes categorization get more accurate for that specific
   client over time (see `schema/003_triggers.sql`).

## Known gaps — being upfront

This has been written for internal consistency (imports, prop types, and
schema all line up) but has **not** been run against a live Next.js dev
server or a real Supabase/Plaid project yet. Expect some first-run
friction — likely candidates:

- Package version mismatches (pin exact versions if `npm install` complains)
- Plaid webhook delivery needs a public URL (use `ngrok` or similar for
  local testing)
- No automated tests yet
- No production-hardening pass (rate limiting, retry/backoff on Plaid sync,
  observability/logging) — this is an MVP skeleton, not a hardened
  production deploy
