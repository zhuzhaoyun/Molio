import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;
/** 云端认证服务（apps/cloud）dev 地址——webServer 健康检查与 daemon env 单点共用。 */
const CLOUD_BASE_URL = 'http://localhost:3200';
/**
 * E2E daemon 端口：默认 3100（现状不变）。当 3100 被另一个 Molio 实例占用
 * （如已安装的桌面端在跑，其旧版路由无法支撑 devCode/市场 E2E，又不可杀掉），
 * 用 `MOLIO_E2E_DAEMON_PORT=3101 pnpm --filter @molio/web exec playwright test`
 * 整体平移：daemon（MOLIO_PORT）+ vite 代理（MOLIO_DAEMON）+ spec 直连同一端口。
 */
const DAEMON_PORT = Number(process.env.MOLIO_E2E_DAEMON_PORT ?? 3100);

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
       /api/auth/start 取验证码（UI 不展示 devCode）。
       资源市场 env（Task 13）：OSS 凭证齐全才装配 /market；MOLIO_MARKET_OSS_ENDPOINT
       指向 mock-oss（:3199），预签名 URL 与服务端 copyObject 全部打到本地替身。 */
    {
      command: 'pnpm --filter @molio/cloud dev',
      url: `${CLOUD_BASE_URL}/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: {
        MOLIO_ENV: 'local',
        MOLIO_OSS_AK: 'test-ak',
        MOLIO_OSS_SK: 'test-sk',
        MOLIO_OSS_BUCKET: 'molio-pay',
        MOLIO_MARKET_OSS_ENDPOINT: 'http://localhost:3199',
        MOLIO_MARKET_ADMIN_EMAILS: 'admin@test.local',
      },
    },
    {
      command: 'pnpm --filter @molio/daemon dev',
      url: `http://localhost:${DAEMON_PORT}/api/health`,
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { MOLIO_AUTH_URL: CLOUD_BASE_URL, MOLIO_PORT: String(DAEMON_PORT) },
    },
    {
      command: 'pnpm --filter @molio/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !isCI,
      timeout: 60_000,
      env: { MOLIO_DAEMON: `http://localhost:${DAEMON_PORT}` },
    },
    /* mock OSS（Task 13）— 预签名 PUT/HEAD/GET 最小替身 + 服务端 copyObject
       （x-oss-copy-source 复制分支，见 fixtures/mock-oss.mjs 头注）。 */
    {
      command: 'node e2e/fixtures/mock-oss.mjs',
      port: 3199,
      reuseExistingServer: !isCI,
    },
  ],
});
