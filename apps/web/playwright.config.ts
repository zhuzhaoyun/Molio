import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isCI = !!process.env.CI;
/**
 * 云端认证服务（apps/cloud）dev 地址——webServer 健康检查与 daemon env 单点共用。
 * 端口可平移（cloud 读 PORT env）：3200 常被另一个 worktree 的 dev server 占用。
 * cloud 只提供验证码，与被测代码版本无关，但为了不干扰别人的会话，
 * 默认仍平移到独立端口。
 */
const CLOUD_PORT = Number(process.env.MOLIO_E2E_CLOUD_PORT ?? 3201);
const CLOUD_BASE_URL = `http://localhost:${CLOUD_PORT}`;
/**
 * E2E daemon 端口：默认 3100（现状不变）。当 3100 被另一个 Molio 实例占用
 * （如已安装的桌面端在跑，其旧版路由无法支撑 devCode/市场 E2E，又不可杀掉），
 * 用 `MOLIO_E2E_DAEMON_PORT=3101 pnpm --filter @molio/web exec playwright test`
 * 整体平移：daemon（MOLIO_PORT）+ vite 代理（MOLIO_DAEMON）+ spec 直连同一端口。
 */
const DAEMON_PORT = Number(process.env.MOLIO_E2E_DAEMON_PORT ?? 3100);
/**
 * E2E web（vite）端口：默认 5173。当 5173 被另一个 worktree 的 dev server
 * 占用时，**复用它会跑到别人的旧代码上**（页面看起来正常、断言全红）——
 * 必须平移端口起自己的 vite。用 `MOLIO_E2E_WEB_PORT=5199` 整体平移。
 */
const WEB_PORT = Number(process.env.MOLIO_E2E_WEB_PORT ?? 5173);
const WEB_BASE_URL = `http://localhost:${WEB_PORT}`;
/** mock OSS 替身端口（可平移：3199 常被其他 worktree 占用）。 */
const MOCK_OSS_PORT = Number(process.env.MOLIO_E2E_MOCK_OSS_PORT ?? 3199);
/**
 * E2E daemon 数据目录（MOLIO_DATA_DIR，db.ts 环境钩子）：每次运行 mkdtemp
 * 新建随机目录，天然干净，不需要先删旧目录——消除 Windows 下「测试 worker
 * 二次加载本文件时，rmSync 撞上已启动 daemon 占用目录」的 EPERM。
 * `??=` 赋值到环境变量：worker 二次加载时继承主进程的 MOLIO_E2E_DATA_DIR，
 * 与主进程共用同一目录（不会各建各的）。
 * 使 E2E 不读写用户真实 ~/.molio（测试 vault 不污染真实数据），也避开真实重型
 * vault 同步扫描阻塞事件循环导致的散点 fetch failed。
 * 注意：仅对"本次 playwright 新拉起的 daemon"生效；reuseExistingServer 复用
 * 已有 daemon 时以对方的数据目录为准。
 */
// Workers re-import this config; share one run directory without deleting an open SQLite DB.
const E2E_DATA_DIR = process.env.MOLIO_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), `molio-e2e-daemon-${DAEMON_PORT}-`));
/* 运行时目录一并隔离（MOLIO_CLAUDE_HOME / MOLIO_CODEX_HOME，见 core/data-dir.ts）：
   runtime-provider-config 直接断言这个 CLAUDE_HOME，不再备份/还原开发者真实的
   ~/.claude/settings.json。写到 process.env 是为了让 spec 进程也能读到同一个路径。 */
process.env.MOLIO_CLAUDE_HOME = join(E2E_DATA_DIR, 'claude');
process.env.MOLIO_CODEX_HOME = join(E2E_DATA_DIR, 'codex');
// Reuse is explicit: a running desktop/dev daemon may use the user's database
// and a different auth backend, so a successful health check is insufficient.
const reuseServers = !isCI && process.env.MOLIO_E2E_REUSE_SERVERS === '1';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  /* All E2E tests share the daemon process — serialise to avoid race conditions
     where one test's vault creation/deletion affects another's vault list query. */
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: WEB_BASE_URL,
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
      reuseExistingServer: reuseServers,
      timeout: 60_000,
      env: {
        MOLIO_ENV: 'local',
        PORT: String(CLOUD_PORT),
        MOLIO_OSS_AK: 'test-ak',
        MOLIO_OSS_SK: 'test-sk',
        MOLIO_OSS_BUCKET: 'molio-pay',
        MOLIO_MARKET_OSS_ENDPOINT: `http://localhost:${MOCK_OSS_PORT}`,
        /* 两个管理员邮箱：market-community 用例 1/3 各用一个，避免同邮箱撞
           send-code 60s 重发限频（429 → 无 devCode → 用例 skip） */
        MOLIO_MARKET_ADMIN_EMAILS: 'admin@test.local,admin2@test.local',
      },
    },
    {
      command: 'pnpm --filter @molio/daemon dev',
      url: `http://localhost:${DAEMON_PORT}/api/health`,
      reuseExistingServer: reuseServers,
      timeout: 60_000,
      env: {
        MOLIO_AUTH_URL: CLOUD_BASE_URL,
        MOLIO_PORT: String(DAEMON_PORT),
        MOLIO_DATA_DIR: E2E_DATA_DIR,
        MOLIO_DEBUG_LOG_DIR: join(E2E_DATA_DIR, 'debug'),
        MOLIO_CLAUDE_HOME: join(E2E_DATA_DIR, 'claude'),
        MOLIO_CODEX_HOME: join(E2E_DATA_DIR, 'codex'),
      },
    },
    {
      command: 'pnpm --filter @molio/web dev',
      url: WEB_BASE_URL,
      reuseExistingServer: reuseServers,
      timeout: 60_000,
      env: {
        MOLIO_DAEMON: `http://localhost:${DAEMON_PORT}`,
        PORT: String(WEB_PORT),
      },
    },
    /* mock OSS（Task 13）— 预签名 PUT/HEAD/GET 最小替身 + 服务端 copyObject
       （x-oss-copy-source 复制分支，见 fixtures/mock-oss.mjs 头注）。 */
    {
      command: 'node e2e/fixtures/mock-oss.mjs',
      port: MOCK_OSS_PORT,
      reuseExistingServer: reuseServers,
      env: { MOLIO_E2E_MOCK_OSS_PORT: String(MOCK_OSS_PORT) },
    },
  ],
});
