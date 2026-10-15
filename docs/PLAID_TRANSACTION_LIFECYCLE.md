# Plaid modified, removed and reappeared transactions

Migration 038 completes the existing provider exception lifecycle. It fixes SQL output-name ambiguity in ingestion and review, permits automatic supersession under the exception resolution-state constraint, and makes review lock the transaction before its exception. Review re-reads the exception after waiting and rejects superseded evidence. Existing role checks, RPC grants, RLS, reversal audit writes, draft protections, and completed reconciliation boundaries are retained. Installation does not invoke ingestion or resolution and changes no transaction or journal records.

The sync layer now treats an existing ID returned as added as a reappearance when either the transaction has a soft-removal timestamp or an open removal exception exists for that Item/client/transaction. A posted removal deliberately leaves the transaction timestamp unchanged; the previous timestamp-only check missed this case. Ordinary added replays remain unchanged. A pending-to-posted event with a new Plaid ID is still a distinct imported transaction, not an inferred same-ID reappearance.

Unjournaled provider changes apply only provider-owned fields. Removed rows are retained. Reappearance clears the soft-removal flag without automatically posting. With an active draft or posted journal, ingestion captures evidence instead of editing the transaction; newer event types supersede older open evidence. An authorized reviewer may dismiss evidence or accept it through existing reversal/repost functions. Acceptance inside a completed reconciliation fails and rolls back. No closed period is reopened automatically.

## Validation and limits

Tests load the repository migrations into disposable PGlite and exercise direct lifecycle changes, posted/draft capture, replay, supersession, acceptance/dismissal, balanced reversal/repost, audit rollback, tenant/account/role/grant checks, and a completed reconciliation. Sync tests execute transpiled production code with mocked Plaid/token/database dependencies: same-ID reappearance, ordinary replay/new inserts, modified/removed dispatch, pagination restart, mutation failure, and cursor comparison. PostgreSQL concurrency tests verify ingestion versus review and posting.

These tests do not call Plaid or Supabase. Before live sandbox validation, manually apply migration 038. Use separate sandbox fixture transactions outside the completed September reconciliation. Read their stored provider values, journals and exceptions before and after each event; validate accepted/dismissed audit records and unchanged completed reconciliation membership. A read-only query alone does not prove real Plaid delivery or concurrent runtime behavior.

The source activation workflow and broader authoritative-source audit remain the next roadmap tasks. This change does not redesign source selection, unknown-account skipping, multi-sync scheduling, or the atomicity of the complete sync batch. Cursor advancement still follows successful per-event mutations; a failed partial batch must replay from the retained original cursor.

Plaid references: https://plaid.com/docs/transactions/sync-migration/ and https://plaid.com/docs/transactions/transactions-data/.
