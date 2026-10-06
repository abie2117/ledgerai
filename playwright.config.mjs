import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'account-mapping-ui.spec.mjs',
  workers: 1,
  use: { browserName: 'chromium' },
  reporter: 'list',
});
