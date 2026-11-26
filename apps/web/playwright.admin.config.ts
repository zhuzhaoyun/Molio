import { defineConfig, devices } from '@playwright/test';

// These tests create their own production Web/daemon/TLS stack. No cloud,
// Vite or OSS servers are needed for their independent access boundary.
export default defineConfig({
  globalSetup: './e2e/fixtures/admin-web-build.ts',
  testDir: './e2e', testMatch: /admin-access-(ui|server)\.spec\.ts/,
  workers: 1, retries: 0, timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { ...devices['Desktop Chrome'], ignoreHTTPSErrors: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
