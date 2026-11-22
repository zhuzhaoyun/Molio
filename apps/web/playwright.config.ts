import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveE2ePorts } from './e2e/helpers/ports';

const isCI = !!process.env.CI;
// Reuse is explicit: a running desktop/dev daemon may use the user's database
// and a different auth backend, so a successful health check is insufficient.
// 自动平移同理：探针证明不了「本 checkout 的代码 + 本次运行的数据目录」，
// 所以 ports.ts 的自动路径只平移、不复用，这里同步保持默认关闭。
const reuseServers = !isCI && process.env.MOLIO_E2E_REUSE_SERVERS === '1';

export default (async () => {
  /**
   * E2E 端口（e2e/helpers/ports.ts，config 异步求值）：
   * - 默认 web=5173 / daemon=3100 / cloud=3201 / mock-oss=3199（与 #417 后一致）；
   * - 默认端口无人监听 → 用默认端口；**有人监听（不论是谁）→ 自动平移到下一个
   *   空闲端口并拉起全新服务**。自动路径永不复用：占用者可能是另一个 checkout
   *   的 dev server（旧代码）或残留 E2E 服务（别人的数据目录），健康探针无法
   *   区分「同签名」和「同代码同数据」，复用即踩跨 checkout 盲区；
   * - 也可显式指定：`MOLIO_E2E_DAEMON_PORT=3101 MOLIO_E2E_WEB_PORT=5174
   *   pnpm --filter @molio/web exec playwright test`（daemon=MOLIO_PORT +
   *   vite 代理 MOLIO_DAEMON + spec 直连同一端口）。
   * 解析结果写回 process.env.MOLIO_E2E_*_PORT：worker 进程继承后按 explicit
   * 短路，二次求值不会又看到「端口被自己占着」而再次平移。
   *
   * 复用（MOLIO_E2E_REUSE_SERVERS=1）会传进解析器：默认端口或显式端口健康
   * 探针命中时标记 reuse，对应 webServer 才打开 reuseExistingServer；其余
   * 服务照常平移或新起，避免「开了复用却永远另起一套」。
   */
  const ports = await resolveE2ePorts({ reuse: reuseServers });
  const WEB_BASE_URL = `http://localhost:${ports.web}`;
  const DAEMON_BASE_URL = `http://localhost:${ports.daemon}`;
  const CLOUD_BASE_URL = `http://localhost:${ports.cloud}`;
  const MOCK_OSS_URL = `http://localhost:${ports.mockOss}`;

  /**
   * E2E daemon 数据目录（MOLIO_DATA_DIR，db.ts 环境钩子）：每次运行 mkdtemp
   * 新建随机目录，天然干净，不需要先删旧目录——消除 Windows 下「测试 worker
   * 二次加载本文件时，rmSync 撞上已启动 daemon 占用目录」的 EPERM。
   * `??=` 赋值到环境变量：worker 二次加载时继承主进程的 MOLIO_E2E_DATA_DIR，
   * 与主进程共用同一目录（不会各建各的）。
   * 使 E2E 不读写用户真实 ~/.molio（测试 vault 不污染真实数据），也避开真实重型
   * vault 同步扫描阻塞事件循环导致的散点 fetch failed。
   * 注意：仅对"本次 playwright 新拉起的 daemon"生效。默认（reuseServers=false）
   * 服务一定由本次运行拉起；显式 MOLIO_E2E_REUSE_SERVERS=1 复用已有 daemon 时，
   * 数据目录以对方为准——这是开启者自己承担的选择，与自动平移无关。
   */
  // Workers re-import this config; share one run directory without deleting an open SQLite DB.
  const E2E_DATA_DIR = process.env.MOLIO_E2E_DATA_DIR ??= mkdtempSync(
    join(tmpdir(), `molio-e2e-daemon-${ports.daemon}-`),
  );
  /* 运行时目录一并隔离（MOLIO_CLAUDE_HOME / MOLIO_CODEX_HOME，见 core/data-dir.ts）：
     runtime-provider-config 直接断言这个 CLAUDE_HOME，不再备份/还原开发者真实的
     ~/.claude/settings.json。写到 process.env 是为了让 spec 进程也能读到同一个路径。 */
  process.env.MOLIO_CLAUDE_HOME = join(E2E_DATA_DIR, 'claude');
  process.env.MOLIO_CODEX_HOME = join(E2E_DATA_DIR, 'codex');

  return defineConfig({
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
         指向 mock-oss，预签名 URL 与服务端 copyObject 全部打到本地替身。 */
      {
        command: 'pnpm --filter @molio/cloud dev',
        url: `${CLOUD_BASE_URL}/health`,
        reuseExistingServer: reuseServers && ports.decisions.cloud.mode === 'reuse',
        timeout: 60_000,
        env: {
          MOLIO_ENV: 'local',
          PORT: String(ports.cloud),
          MOLIO_OSS_AK: 'test-ak',
          MOLIO_OSS_SK: 'test-sk',
          MOLIO_OSS_BUCKET: 'molio-pay',
          MOLIO_MARKET_OSS_ENDPOINT: MOCK_OSS_URL,
          /* 两个管理员邮箱：market-community 用例 1/3 各用一个，避免同邮箱撞
             send-code 60s 重发限频（429 → 无 devCode → 用例 skip） */
          MOLIO_MARKET_ADMIN_EMAILS: 'admin@test.local,admin2@test.local',
        },
      },
      {
        command: 'pnpm --filter @molio/daemon dev',
        url: `${DAEMON_BASE_URL}/api/health`,
        reuseExistingServer: reuseServers && ports.decisions.daemon.mode === 'reuse',
        timeout: 60_000,
        env: {
          MOLIO_AUTH_URL: CLOUD_BASE_URL,
          MOLIO_PORT: String(ports.daemon),
          MOLIO_DATA_DIR: E2E_DATA_DIR,
          MOLIO_DEBUG_LOG_DIR: join(E2E_DATA_DIR, 'debug'),
          MOLIO_CLAUDE_HOME: join(E2E_DATA_DIR, 'claude'),
          MOLIO_CODEX_HOME: join(E2E_DATA_DIR, 'codex'),
          MOLIO_SAMPLE_VAULT_PATH: join(E2E_DATA_DIR, 'sample-vault'),
        },
      },
      {
        command: 'pnpm --filter @molio/web dev',
        url: WEB_BASE_URL,
        reuseExistingServer: reuseServers && ports.decisions.web.mode === 'reuse',
        timeout: 60_000,
        env: {
          MOLIO_DAEMON: DAEMON_BASE_URL,
          PORT: String(ports.web),
        },
      },
      /* mock OSS（Task 13）— 预签名 PUT/HEAD/GET 最小替身 + 服务端 copyObject
         （x-oss-copy-source 复制分支，见 fixtures/mock-oss.mjs 头注）。
         /__health 标记端点供端口占用判定（区分非本服务的占用者）。 */
      {
        command: 'node e2e/fixtures/mock-oss.mjs',
        port: ports.mockOss,
        reuseExistingServer: reuseServers && ports.decisions.mockOss.mode === 'reuse',
        env: { MOLIO_E2E_MOCK_OSS_PORT: String(ports.mockOss) },
      },
    ],
  });
})();
