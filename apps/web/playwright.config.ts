import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  /* All E2E tests share the daemon process — serialise to avoid race conditions
     where one test's vault creation/deletion affects another's vault list query. */
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  /*
   * E2E tests require both daemon (:3100) and web (:5173) running.
   * Start them manually with `pnpm dev` before running `npx playwright test`.
   *
   * Alternatively, uncomment below to auto-start (requires pnpm in PATH):
   * webServer: [
   *   { command: 'pnpm --filter @molio/daemon dev', url: 'http://localhost:3100/api/health', reuseExistingServer: true },
   *   { command: 'pnpm --filter @molio/web dev', url: 'http://localhost:5173', reuseExistingServer: true },
   * ],
   */
});
