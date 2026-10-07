# Dynamic transaction sandbox testing

The normal Refresh action collects existing provider changes. Generate test update requests `/transactions/refresh`, allowing a dynamic sandbox user to advance its test data. Plaid processes the request asynchronously; webhooks and normal Refresh collect the changes through the existing ingestion boundary.

Enable only an isolated client and connection using server environment variables:

```
PLAID_ENV=sandbox
PLAID_SANDBOX_TEST_CLIENT_ID=<isolated LedgerAI client UUID>
PLAID_SANDBOX_TEST_CONNECTION_ID=<isolated plaid_items database UUID>
```

The control is hidden and the server rejects requests unless both identifiers match exactly, the provider is active, and the financial source is pending review. Existing authenticated firm membership and opaque connection reference checks apply before the action. The access token remains on the server. The action logs the authenticated actor, client, and connection without credentials. Disable the two test identifiers after validation.

Use a connection established with `user_transactions_dynamic` at First Platypus Bank. Click Generate test update, wait for provider processing, then use Refresh. Inspect added and removed transactions before requesting another update. Pending-to-posted transitions may remove the pending transaction and add a posted transaction under a new provider ID; this does not prove a same-ID modified or reappeared event.

This action does not activate sources, approve transactions, post journals, or reopen reconciliations. Provider event validation for posted journals remains a separate test.

Validation: `node --test --experimental-test-isolation=none tests/plaid-sandbox-refresh.test.mjs tests/plaid-sync.test.mjs`.
