import { defineConfig } from '@playwright/test';

// SSR markup + real landing assets, with mocked network; no daemon or live payments.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'resource-mobile.spec.ts',
  use: { browserName: 'chromium', screenshot: 'only-on-failure' },
  reporter: 'list',
});
