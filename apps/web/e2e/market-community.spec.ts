import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area market
 * @priority P1
 *
 * E2E：社区发布 → 展示 → 下载闭环（mock OSS）。
 *
 * 「发布到资源库」入口现仅管理员可打开发布 tab（非管理员/未登录 → 系统浏览器打开
 * 官网联系页上架，见用例 4），故用例 1/3 用 playwright.config 注入的管理员邮箱登录。
 *
 * 用例 1（登录闭环）：devCode 登录（管理员）→ ?vault= 直达含 md 的知识库 → 面板「发布到资源库」
 * 打开页内发布 tab → 填名称/简介、上传 1×1 PNG 效果图、勾公开声明 → 发布成功；
 * /resources 出现新卡片带「社区分享」角标，社区筛选下仍可见；详情页预览图真实渲染
 * （src 指向 mock OSS :3199 且 naturalWidth>0 —— 证明 confirm 的 copyObject 把字节
 * 复制到位而非空字节）、「下载 .zip」按钮在、社区说明与举报入口在；点下载新开页
 * 请求指向 mock OSS 的签名 GET（zip 键 + Signature）。
 *
 * 用例 2（未登录门槛）：资源页可浏览（官方货架可见）；对免费条目（=用例 1 发布的
 * 社区条目，官方目录全付费）点下载 → 账号面板登录视图出现，未产生任何新页/下载跳转。
 *
 * 用例 3（AI 手动触发）：发布 tab 打开即空表单——无 loading、无 publish-suggest
 * 请求；点「AI 一键配置」才触发（route mock 秒回，避开真实 120s agent spawn），
 * 回填字段并出现「重新生成」。
 *
 * 依赖：playwright.config webServer 起 fixtures/mock-oss.mjs（:3199）并给 cloud 注入
 * MOLIO_OSS_AK/SK/BUCKET + MOLIO_MARKET_OSS_ENDPOINT，签名 URL 与服务端 copyObject
 * （x-oss-copy-source）全部打到本地替身。
 *
 * 服务全部由 playwright webServer 自动拉起（无需手动 `pnpm dev`）：cloud (:3200) +
 * daemon (:3100) + web (:5173) + mock-oss (:3199)；端口冲突可用
 * `MOLIO_E2E_DAEMON_PORT` 整体平移（见 playwright.config.ts 头注）。
 */

/** daemon 直连地址：跟随 MOLIO_E2E_DAEMON_PORT 平移（见 playwright.config.ts 头注） */
const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;
const MOCK_OSS = 'http://localhost:3199';
const ACCOUNT_MODAL = '.account-modal';

/** 1×1 PNG —— 效果图经 setInputFiles 以 Buffer 注入（不落盘） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/** fetch with a hard timeout so hooks never hang if daemon is unreachable */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 每次运行唯一名——避免残留库/重名卡片造成 strict-mode 碰撞 */
const vaultName = `e2e-mkt-${Date.now()}`;
const resourceName = `E2E 社区资源 ${Date.now()}`;
let testVaultPath = '';
let vaultId = '';

test.beforeAll(async () => {
  // 0. 清理上次崩溃残留的 e2e-mkt-* 库
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-mkt-')) {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon might not be running yet */ }

  // 1. 临时目录 + md 文件（发布编排会把整库打包成 zip）
  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-market-'));
  writeFileSync(
    join(testVaultPath, 'community-doc.md'),
    '# E2E 社区发布\n\n这是一篇用于社区发布闭环验证的文档。\n',
  );

  // 2. 经 daemon API 建库（UI 侧 reload 后由 vault store 拉取，同 publish-flow 模式）
  const res = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: testVaultPath }),
  });
  vaultId = ((await res.json()) as { id: string }).id;
});

test.afterAll(async () => {
  if (vaultId) {
    await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  }
  if (testVaultPath) rmSync(testVaultPath, { recursive: true, force: true });
});

/**
 * 重置共享 daemon 登录态（登录态落 sqlite，跨运行残留）：已登录则登出，
 * 保证 loginViaDevCode 看到的是登录表单而非资料卡。照抄 auth.spec.ts 用法。
 */
async function ensureLoggedOut(request: APIRequestContext) {
  const status = (await (await request.get('/api/auth/status')).json()) as { loggedIn?: boolean };
  if (status.loggedIn) await request.post('/api/auth/logout');
}

/**
 * devCode 登录（照抄 auth.spec.ts 流程）：邮箱 → 勾协议 → 发送验证码 →
 * 从 /api/auth/start 响应取 devCode（UI 不展示）→ 填码验证 → 关闭面板。
 */
async function loginViaDevCode(page: Page, email: string) {
  await page.locator('[data-testid="nav-account-btn"]').click();
  await expect(page.locator(ACCOUNT_MODAL)).toBeVisible();
  await page.locator('[data-testid="account-email-input"]').fill(email);
  // 协议勾选是发送验证码的前置（同 auth.spec）
  await page.locator('[data-testid="account-agree-checkbox"]').check();
  const startResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/start') && r.request().method() === 'POST',
  );
  await page.locator('[data-testid="account-send-code-btn"]').click();
  const body = (await (await startResp).json()) as { devCode?: string };
  if (typeof body.devCode !== 'string') {
    test.skip(true, 'cloud did not return devCode (prod-mode cloud) — cannot fetch code in E2E');
  }
  await page.locator('[data-testid="account-code-input"]').fill(body.devCode as string);
  await page.locator('[data-testid="account-verify-btn"]').click();
  await expect(page.locator('[data-testid="account-logged-email"]')).toHaveText(email, {
    timeout: 10_000,
  });
  await page.locator('[data-testid="account-modal-close"]').click();
  await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();
}

test.describe('社区发布 → 展示 → 下载闭环（P1，mock OSS）', () => {
  test('社区发布 → 资源页可见 → 详情 → 下载', async ({ page, request }) => {
    // 登录 + 发布编排（打包→直传→confirm）+ 资源页/详情页导航，预算放宽
    test.setTimeout(90_000);

    await ensureLoggedOut(request);
    // 1) 登录（现有 devCode 流程）：发布 tab 现仅管理员可打开（非管理员被引导到官网
    //    联系页上架）——用 playwright.config 注入的管理员邮箱登录以走通发布闭环。
    await gotoHome(page);
    await loginViaDevCode(page, 'admin@test.local');

    // 「我的上架」入口仅管理员可见：账号弹层展开应见按钮
    await page.locator('[data-testid="nav-account-btn"]').click();
    await expect(page.locator('[data-testid="account-my-listings-btn"]')).toBeVisible({
      timeout: 5_000,
    });
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();

    // 2) ?vault= 直达 beforeAll 建的含 md 库的 KB 页（per-window source of truth）。
    //    门禁在点击时同步判定 isAdmin——先挂监听等 /my 预取落定再点，消除竞态
    //    （goto 前挂监听防漏响应）。
    const mySettled = page
      .waitForResponse((r) => r.url().includes('/api/market/my'), { timeout: 10_000 })
      .catch(() => null);
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await mySettled;

    // 3) 面板「发布到资源库」→ 页内发布 tab：名称/简介 + 效果图 + 声明 → 提交 → 成功态
    await page.locator('[data-testid="kb-btn-publish-vault"]').click({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-publish-pane"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-wtab-publish"]')).toHaveClass(/is-active/);

    // 名称是 input、简介是 textarea（旧版用 input 序号 [1] 填简介会误中自定义标签输入框）
    await page.locator('.publish-form .publish-field input').first().fill(resourceName);
    await page
      .locator('.publish-form .publish-field textarea')
      .fill('E2E 自动发布的社区资源，用于 P1 门禁验证');
    await page.locator('.publish-preview-add input[type="file"]').setInputFiles({
      name: 'preview-1x1.png',
      mimeType: 'image/png',
      buffer: PNG_1PX,
    });
    await expect(page.locator('.publish-preview-item')).toHaveCount(1);
    await page.locator('.publish-agreement input[type="checkbox"]').check();
    await page.locator('[data-testid="publish-submit-btn"]').click();
    // 成功态（文案 publish.done）；打包 + 直传 + confirm 全在本地，秒级但留足余量
    await expect(page.locator('.publish-done')).toContainText('发布成功', { timeout: 30_000 });
    await page.locator('[data-testid="publish-close-btn"]').click(); // done 态主按钮 = 关闭（关 tab）
    await expect(page.locator('[data-testid="kb-publish-pane"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="kb-wtab-publish"]')).toHaveCount(0);

    // 4) /resources：新卡片出现且带「社区分享」角标；社区筛选下仍可见
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();
    const card = page
      .locator('[data-testid^="resource-card-"]')
      .filter({ hasText: resourceName });
    await expect(card).toBeVisible({ timeout: 10_000 });
    const listingId = ((await card.getAttribute('data-testid')) as string).replace(
      'resource-card-',
      '',
    );

    // 5) 详情页（社区变体）：预览图渲染 + 下载按钮 + 社区说明/举报入口
    await page.locator(`[data-testid="resource-detail-link-${listingId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${listingId}$`));
    await expect(page.locator('.resources-detail-head h1')).toHaveText(resourceName);

    const previewImg = page.locator('.resources-preview-grid img').first();
    await previewImg.scrollIntoViewIfNeeded(); // loading=lazy，滚入视口才会加载
    await expect(previewImg).toBeVisible({ timeout: 10_000 });
    expect(await previewImg.evaluate((el) => (el as HTMLImageElement).src)).toContain(
      `${MOCK_OSS}/`,
    );
    // naturalWidth>0 证明预览字节经 confirm 的 copyObject 复制到位（非空字节破图）
    await expect(async () => {
      const w = await previewImg.evaluate((el) => (el as HTMLImageElement).naturalWidth);
      expect(w).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    await expect(page.locator(`[data-testid="resource-buy-${listingId}"]`)).toHaveText(
      '下载 .zip',
    );
    // 6) 点下载：新开页导航指向 mock OSS 的签名 GET（zip 键 + Signature）
    const popupPromise = page.context().waitForEvent('page', { timeout: 15_000 });
    const ossReqPromise = page.context().waitForEvent('request', {
      predicate: (r) => r.url().startsWith(`${MOCK_OSS}/`),
      timeout: 15_000,
    });
    await page.locator(`[data-testid="resource-buy-${listingId}"]`).click();
    const [popup, ossReq] = await Promise.all([popupPromise, ossReqPromise]);
    expect(ossReq.url()).toContain(`${MOCK_OSS}/zips/${listingId}-vault.zip`);
    expect(ossReq.url()).toContain('Signature='); // 预签名 GET，非裸链
    await popup.close().catch(() => {});
  });

  test('未登录：资源页可浏览，下载拉起登录门槛', async ({ page, request }) => {
    test.setTimeout(60_000);

    // 全部用例共享同一 daemon 登录态：先清掉上个用例残留的登录
    await ensureLoggedOut(request);

    // 浏览可用：未登录也能看货架。目录异步加载——用自等待断言而非即时 count，
    // 防 shell 已渲染但数据未达的竞态
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();
    await expect(page.locator('[data-testid^="resource-card-"]').first()).toBeVisible({
      timeout: 10_000,
    });

    // 免费条目：官方目录全付费，免费筛选下是上个用例发布的社区条目（价格恒 0）
    await page.locator('[data-testid="resources-filter-free"]').click();
    const freeCards = page.locator('[data-testid^="resource-card-"]');
    await expect(freeCards.first()).toBeVisible({ timeout: 10_000 });
    const id = ((await freeCards.first().getAttribute('data-testid')) as string).replace(
      'resource-card-',
      '',
    );
    const downloadBtn = page.locator(`[data-testid="resource-buy-${id}"]`);
    // 未登录门槛文案（社区免费条目 = resources.downloadLogin「登录后下载」）
    await expect(downloadBtn).toHaveText(/登录后/);

    // 门槛拦截：拉起账号面板登录视图；不产生任何新页/下载跳转
    let unexpectedPopup = false;
    page.context().on('page', () => {
      unexpectedPopup = true;
    });
    await downloadBtn.click();
    await expect(page.locator(ACCOUNT_MODAL)).toBeVisible();
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();
    await page.waitForTimeout(500); // 给潜在的（不应发生的）跳转留出暴露窗口
    expect(unexpectedPopup).toBe(false);
    expect(page.url()).toContain('/resources');
  });

  test('发布 tab：打开不自动生成，AI 配置仅用户主动点击触发（route mock）', async ({ page, request }) => {
    test.setTimeout(60_000);

    await ensureLoggedOut(request);
    // 自行登录；发布 tab 仅管理员可打开，故用管理员邮箱（admin2 与用例 1 错开，
    // 避免同邮箱撞 send-code 60s 重发限频）
    await gotoHome(page);
    await loginViaDevCode(page, 'admin2@test.local');

    // 同用例 1：等 /my 预取落定再点，消除门禁竞态
    const mySettled = page
      .waitForResponse((r) => r.url().includes('/api/market/my'), { timeout: 10_000 })
      .catch(() => null);
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await mySettled;
    await page.locator('[data-testid="kb-btn-publish-vault"]').click();
    await expect(page.locator('[data-testid="kb-publish-pane"]')).toBeVisible();

    // 行为 1：打开即空表单——无 loading 态、无 publish-suggest 请求
    await expect(page.locator('[data-testid="publish-ai-btn"]')).toBeEnabled();
    await expect(page.locator('.publish-ai-spinner')).toHaveCount(0);
    let suggested = false;
    page.on('request', (r) => {
      if (r.url().includes('/api/market/publish-suggest')) suggested = true;
    });
    await page.waitForTimeout(800);
    expect(suggested).toBe(false);

    // 行为 2：主动点击才触发（route mock 秒回，避开真实 120s agent spawn）
    await page.route('**/api/market/publish-suggest', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          name: 'AI模拟名称',
          summary: 'AI模拟简介',
          tags: ['模拟标签'],
          icon: '📚',
          agentId: 'mock',
        }),
      }),
    );
    await page.locator('[data-testid="publish-ai-btn"]').click();
    await expect(page.locator('.publish-form .publish-field input').first()).toHaveValue('AI模拟名称', {
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid="publish-ai-regen"]')).toBeVisible();
    // 不提交，到此为止（关页面即放弃，不做关 tab 断言以保持用例聚焦）
  });

  test('非管理员：点「发布到资源库」→ 系统浏览器打开官网联系页，不进发布 tab', async ({ page, request }) => {
    test.setTimeout(60_000);
    await ensureLoggedOut(request);
    // 登录为非管理员（非 admin@test.local / admin2@test.local）
    await gotoHome(page);
    await loginViaDevCode(page, `molio-e2e-gate-${Date.now()}@example.com`);

    // 「我的上架」入口对非管理员隐藏（等 /my 落定再断言，防未决态假通过）
    const myListingsSettled = page
      .waitForResponse((r) => r.url().includes('/api/market/my'), { timeout: 10_000 })
      .catch(() => null);
    await page.locator('[data-testid="nav-account-btn"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).toBeVisible();
    await myListingsSettled;
    await expect(page.locator('[data-testid="account-my-listings-btn"]')).toHaveCount(0);
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();

    // 同用例 1：等门禁状态落定再点（也顺带等 vault 解析，防 activeVault 未决早退）
    const mySettled = page
      .waitForResponse((r) => r.url().includes('/api/market/my'), { timeout: 10_000 })
      .catch(() => null);
    await page.goto(`http://localhost:5173/knowledge?vault=${vaultId}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await mySettled;

    // 官网联系页（外部真实网络不可依赖）→ context 级 route mock（window.open 的新
    // 页也在同一 context）；断言新开页指向联系页，且应用页未离开、未打开发布 tab
    await page.context().route('**/enterprise.html*', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>联系我们</body></html>' }),
    );
    const popupPromise = page.context().waitForEvent('page', { timeout: 10_000 });
    await page.locator('[data-testid="kb-btn-publish-vault"]').click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    expect(popup.url()).toContain('enterprise.html');
    // 应用页留在原处：无 SPA 导航、无发布 tab
    expect(page.url()).toContain('/knowledge');
    await expect(page.locator('[data-testid="kb-publish-pane"]')).toHaveCount(0);
    await popup.close().catch(() => {});
  });
});
