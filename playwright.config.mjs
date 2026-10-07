import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['account-mapping-ui.spec.mjs', 'chart-of-accounts-ui.spec.mjs', 'reconciliation-balances-ui.spec.mjs', 'vendor-recurring-ui.spec.mjs'],
  workers: 1,
  use: { browserName: 'chromium' },
  reporter: 'list',
});
