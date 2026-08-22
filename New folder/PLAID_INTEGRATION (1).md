# LedgerAI — Plaid Integration Plan

## 1. Flow overview

```
Bookkeeper adds a client
        │
        ▼
Frontend requests a Link Token  ──►  POST /api/plaid/link-token
        │
        ▼
Plaid Link UI opens (client's bank login happens inside Plaid's UI —
LedgerAI never sees or stores bank credentials)
        │
        ▼
Plaid returns a public_token to the frontend
        │
        ▼
Frontend sends public_token to backend  ──►  POST /api/plaid/exchange
        │
        ▼
Backend exchanges it for an access_token + item_id via Plaid's
/item/public_token/exchange endpoint
        │
        ▼
access_token is encrypted (pgcrypto) and stored in plaid_items
        │
        ▼
Initial transaction pull via /transactions/sync (cursor = null)
        │
        ▼
Transactions land in `transactions` table, status = pending_review
        │
        ▼
Categorization job runs (see CATEGORIZATION.md) → ai_category_id + confidence
        │
        ▼
Bookkeeper reviews in the UI, confirms or corrects
        │
        ▼
Corrections write to category_corrections + update category_mapping_rules
```

## 2. Why `/transactions/sync`, not `/transactions/get`

Plaid's `/transactions/sync` endpoint is cursor-based and returns only what's
changed (added/modified/removed) since the last cursor. This matters for
LedgerAI specifically:

- Firms will have many clients, each with multiple accounts — polling
  `/transactions/get` on a schedule for all of them doesn't scale well.
- The cursor model lets us react to Plaid webhooks (`SYNC_UPDATES_AVAILABLE`)
  and pull only the delta, which keeps sync cheap and near-real-time.
- Removed/modified transactions are surfaced explicitly, which we need for
  reconciliation integrity (a transaction a bookkeeper already categorized
  shouldn't silently disappear without a trace in `audit_log`).

## 3. Webhook handling

Register a single webhook URL per Plaid item at link time. Handle:

| Webhook code | Action |
|---|---|
| `SYNC_UPDATES_AVAILABLE` | Enqueue a sync job for that `plaid_item_id` |
| `ITEM_ERROR` | Mark `plaid_items.status = 'error'`, notify the firm |
| `PENDING_EXPIRATION` | Prompt bookkeeper to re-auth via Plaid Link update mode before access lapses |
| `USER_PERMISSION_REVOKED` | Mark `plaid_items.status = 'revoked'`, stop sync jobs |

Webhook handler should be idempotent (Plaid can redeliver) — key sync jobs by
`plaid_item_id` + cursor so a duplicate delivery is a no-op.

## 4. Token security

- `access_token` is never stored in plaintext. Encrypt with `pgcrypto`
  (`pgp_sym_encrypt`) using a key held in environment/secrets manager, not in
  the database.
- Decrypt only inside a server-side function at call time — never sent to
  the frontend, never logged.
- Rotate the encryption key on a schedule; keep a key-version column if you
  expect to rotate more than once (`access_token_key_version`).

## 5. Multi-client, multi-account scaling

Each `clients` row can have multiple `plaid_items` (a business may bank with
more than one institution), and each `plaid_items` row can have multiple
`accounts` (checking + savings + credit card under one login). Sync jobs
should be queued per `plaid_item_id`, not per client, so one slow/erroring
institution connection doesn't block sync for a client's other accounts.

## 6. Initial pull vs. ongoing sync

- **Initial pull**: on item creation, run `/transactions/sync` repeatedly
  with `has_more: true` until exhausted, storing the returned cursor at the
  end. This can return 90–730 days of history depending on the institution —
  surface a progress indicator in the UI rather than blocking on it.
- **Ongoing sync**: triggered by webhook, pulls only the delta using the
  stored cursor, then updates `plaid_items.cursor` and `last_synced_at`.

## 7. Error handling / firm-facing status

Surface `plaid_items.status` directly in the firm's client list UI (Active /
Needs re-auth / Revoked) — a stale connection silently failing is the kind of
trust-breaking bug that undermines the "can't do without it" positioning this
product depends on.

## 8. Environment variables needed

```
PLAID_CLIENT_ID=
PLAID_SECRET=
PLAID_ENV=sandbox        # sandbox → development → production
PLAID_WEBHOOK_URL=
PLAID_TOKEN_ENCRYPTION_KEY=
```

Start entirely in `sandbox` mode with Plaid's test institutions before
requesting `production` access, which requires an app review from Plaid.
