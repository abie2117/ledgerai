# Recurring evidence source boundaries

Recurring detection and review require both provider status `active` and financial source status `active`, with the source belonging to the selected client. Superseded, revoked, pending, missing, and foreign sources fail closed. Account identity remains the grouping key; identical merchant names and masks are not deduplicated across accounts.

Migration 037 replaces the protected recurring RPCs from migration 028. Detection remains service-role-only; vendor linking and confirmation/dismissal retain authenticated owner/admin/bookkeeper checks and audit writes. The private source-lock helper is not granted to application roles. Locks follow provider → account → candidate order, so source transitions and recurring writes serialize. Vendor linking locks the matching source/account set in ID order, requires current evidence, and only updates candidates on active sources. Its existing merchant-level signature is retained, but historical-only merchant linking now rejects.

No historical candidates or transactions are deleted, moved, dismissed, or reactivated. Historical candidates retain their stored status, vendor association, and timestamps. The screen excludes them from actionable counts and shows them in a read-only expandable section. As before, dismissed candidates are omitted from this screen. Confirmation remains evidence-only and creates no posting, payment, approval, or reconciliation.

## Deployment and runtime verification

Review and apply `schema/037_authoritative_recurring_sources.sql` manually before using the updated review controls. The code does not run a migration automatically. Do not rerun detection to repair historical candidates.

For Acme's reported Fun pattern, the expected screen has one active candidate (`190fb506-c858-4e1c-9be2-783b9fb3f22f`) on canonical account `9dcf5588-c997-42fa-81bf-792e9398deac`; the eight superseded candidates remain historical. Verify the three canonical transaction IDs, dates, amounts, and merchant evidence before confirming. Then verify the confirmation audit and unchanged journal/transaction counts. Do not change the completed September reconciliation.

## Validation

`npm run test:account-mapping` loads the actual migrations into disposable PGlite and covers source states, tenant and role boundaries, grants, repeat review, audit rollback, historical preservation, and detector filtering. The detector query test mocks PostgREST; it does not establish live relationship resolution. PostgreSQL concurrency tests cover source transitions racing with detection and review. Browser tests cover counts, read-only history, canonical confirmation, source rejection, and viewer access. GitHub CI runs PostgreSQL and Chromium checks; live Supabase validation remains separate.
