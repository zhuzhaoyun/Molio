import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Electron E2E tests.
 *
 * Unlike web E2E, we don't use `webServer` — the Electron app
 * bundles its own daemon + static web server.
 *
 * Prerequisites:
 *   pnpm build && npx electron-builder --win --dir
 *
 * Run:
 *   npx playwright test --config e2e/playwright.config.ts
 *   npx playwright test --config e2e/playwright.config.ts --headed
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: false, // Sequential: each test owns the full app lifecycle
  workers: 1, // Serialize across files too — the app holds a single-instance
  // lock and port 3100, so two spec files launching Molio concurrently make
  // the loser exit immediately (electron.launch: target closed, exitCode=1).
  retries: 0,
  timeout: 120_000, // 2 min per test (includes daemon startup wait)
  globalSetup: './global-setup.ts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'e2e-results' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
