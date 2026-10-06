# Account mapping succession

Migration `035_atomic_account_mapping_transfer.sql` adds
`transfer_account_coa_mapping(client, from_account, to_account, expected_category)`.
It defines the operation but does not execute a transfer or modify existing data.
Apply only after migrations through 034 have been deployed and deployment has
been approved. No migration or transfer was run against Supabase during development.

The operation requires authenticated owner/admin/bookkeeper membership in the
client's firm. Both accounts must belong to that client. The old account's
financial source must already be superseded **by the destination's source**.
The destination must be provider-active, financially active, and unmapped.
The old mapping must still match the explicitly supplied expected category.
The category must be an active, client-specific asset/liability posting account
with a valid normal balance. Both accounts must have zero active original
draft/posted journals and zero reconciliation records of any status.

Provider rows and account rows are locked in deterministic order, then the
category is locked. The old mapping is released before the new one is assigned,
preserving the immediate unique mapping constraint. Existing validation and
active-journal protection triggers remain enabled. Both mapping updates and
an audit record commit together or roll back together. Transactions, journals,
reconciliations, categories, and source status are not changed by the transfer.
Repeated/stale requests fail rather than generating another audit event.

The API accepts `action: transfer`, `clientId`, `accountId` (destination),
`fromAccountId`, and `categoryId` (expected existing mapping). Accounting Setup
shows a transfer option for a mapped superseded account whose recorded successor
is the destination source. The user reviews the two accounts and ledger mapping
in a confirmation. Database checks, not the displayed option, determine eligibility.
Occupied categories are disabled in the ordinary mapping selector.

## Posting safeguard restored

Migration 034 replaced the posting function from 029 and omitted its account
lock and completed reconciliation period check. Migration 035 restores those
two safeguards while retaining 034's active financial/provider source checks
and the existing journal posting procedure. Posting locks its transaction and
account before inspecting the mapping; the transfer does not lock transactions,
avoiding an inverted transaction/account lock order.

## Verification and limits

Run `npm run test:account-mapping` with Node 22. The tests use an isolated
PGlite PostgreSQL engine, load repository migrations through 035, and exercise
actual functions, constraints, and triggers. Supabase token-encryption/Vault
migrations (002, 004–006) are excluded; auth roles/users and UUID generation
are supplied locally. The repository is missing the original migration adding
`transactions.category`, which migrations 018 onward assume. The test harness
explicitly supplies that legacy column; this is not a fresh-install migration
repair or proof that every Supabase migration can be replayed unmodified.

Tests cover successful transfer and audit contents, preserved transactions and
sources, stale replay, role/tenant checks, source lifecycle and successor checks,
occupied destination, category eligibility, journal and reconciliation blockers,
audit-insert rollback, anonymous privileges, balanced posting after succession,
and revoked-source/completed-period posting rejection.

PGlite runs one database session, so simultaneous multi-session race/deadlock
tests still need a disposable PostgreSQL staging environment. Live ACME records,
UI interactions against Supabase, and production transfer remain unverified.
The supplied retained source ID is not hardcoded; account IDs and the current
mapping must be freshly checked before a later authorized runtime transfer.

Local TypeScript checking passed. The production build compiled, then the
sandbox prevented spawning the TypeScript worker (`EPERM`); the complete build
is therefore unverified. Repository-wide lint currently reports 57 errors and
14 warnings, including the pre-existing Accounting Setup effect rule violation.
The proposed change does not resolve those unrelated baseline issues.
