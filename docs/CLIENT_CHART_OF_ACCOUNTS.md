# Client Chart of Accounts

The Accounting workspace now lists client-specific ledger accounts and provides
a creation form for Asset, Liability, Equity, Revenue and Expense posting accounts.
The normal balance follows the existing schema constraint; new accounts are active.
Legacy unclassified client accounts remain visible with a Needs classification status.
This scope creates accounts only; it does not edit, classify or delete existing accounts.

Migration 036 installs create_client_ledger_account. It requires an authenticated
owner/admin/bookkeeper of the client's firm, serializes calls on the client row,
rejects existing client codes/names, and commits creation and its audit record together.
The duplicate check covers this RPC; it does not add a global unique index or change
the existing create-and-map operation. Shared categories may retain the same labels.
No RLS policy, bank mapping, transaction, shared category or journal is changed.

After applying migration 036 and deploying the application, open Accounting,
scroll to Chart of Accounts, and create Travel / 6110 / Expense for the client.
Return to Transactions and refresh to load the new category. Select the client
Travel account for the intended transaction using the existing correction flow,
review its business purpose, approve it if necessary, then post through the app.
Creating a category does not approve or post transactions.

Validation uses the existing isolated migration fixture (including its documented
auth/UUID scaffolding, supplied legacy category column, and Vault exclusions).
Database tests cover authorization, tenancy, invalid input, duplicates, all normal
balances, audit rollback, unchanged shared categories, and actual balanced posting.
Chromium component tests use synthetic API responses for creation, server permissions,
and rejection. Live Supabase/API integration remains a separate runtime check.
