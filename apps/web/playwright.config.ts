import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
/** 云端认证服务（apps/cloud）dev 地址——webServer 健康检查与 daemon env 单点共用。 */
const CLOUD_BASE_URL = 'http://localhost:3200';

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
    /* 云端认证服务（M1）— 必须先于 daemon 起来，daemon 拿 MOLIO_AUTH_URL 指向它。
       本地 MOLIO_ENV=local：内存 store + 响应带 devCode，E2E 直接从
       /api/auth/start 取验证码（UI 不展示 devCode）。 */
    {
      command: 'pnpm --filter @molio/cloud dev',
      url: `${CLOUD_BASE_URL}/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { MOLIO_ENV: 'local' },
    },
    {
      command: 'pnpm --filter @molio/daemon dev',
      url: 'http://localhost:3100/api/health',
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { MOLIO_AUTH_URL: CLOUD_BASE_URL },
    },
    {
      command: 'pnpm --filter @molio/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
    },
  ],
});
