import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

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
    screenshot: 'only-on-failure',
  },
  reporter: isCI
    ? [
        ['list'],
        ['html', { open: 'never', outputFolder: './playwright-report' }],
        ['json', { outputFile: './test-results/results.json' }],
        ['junit', { outputFile: './test-results/junit.xml' }],
      ]
    : [
        ['list'],
        ['html', { open: 'never', outputFolder: './playwright-report' }],
      ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @molio/daemon dev',
      url: 'http://localhost:3100/api/health',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @molio/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
