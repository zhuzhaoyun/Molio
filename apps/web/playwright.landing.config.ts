import { defineConfig } from '@playwright/test';

// Route-backed website tests: no daemon or user data required.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['resource-alipay.spec.ts'],
  workers: 1,
  use: { screenshot: 'only-on-failure' },
});
