import { test, expect, type Page } from '@playwright/test';
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
 * 用例 1（登录闭环）：devCode 登录 → 选中含 md 的知识库 → 仓库管理器「发布到资源库」
 * → 向导填名称/简介、上传 1×1 PNG 效果图、勾公开声明 → 发布成功；
 * /resources 出现新卡片带「社区分享」角标，社区筛选下仍可见；详情页预览图真实渲染
 * （src 指向 mock OSS :3199 且 naturalWidth>0 —— 证明 confirm 的 copyObject 把字节
 * 复制到位而非空字节）、「下载 .zip」按钮在、社区说明与举报入口在；点下载新开页
 * 请求指向 mock OSS 的签名 GET（zip 键 + Signature）。
 *
 * 用例 2（未登录门槛）：资源页可浏览（官方货架可见）；对免费条目（=用例 1 发布的
 * 社区条目，官方目录全付费）点下载 → 账号面板登录视图出现，未产生任何新页/下载跳转。
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
  test('社区发布 → 资源页可见 → 详情 → 下载', async ({ page }) => {
    // 登录 + 发布编排（打包→直传→confirm）+ 资源页/详情页导航，预算放宽
    test.setTimeout(90_000);

    // 1) 登录（现有 devCode 流程）
    await gotoHome(page);
    await loginViaDevCode(page, `molio-e2e-mkt-${Date.now()}@example.com`);

    // 2) 进知识库，打开仓库管理器，选中 beforeAll 建的含 md 库的发布入口
    //    （reload 让 vault store 重新拉取 daemon 侧新建的库，同 publish-flow 模式）
    await page.reload({ waitUntil: 'networkidle' });
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });

    // 3) 「发布到资源库」→ 发布向导：名称/简介 + 效果图 + 声明 → 提交 → 成功态
    const vaultItem = page.locator('.vm-vault-item').filter({ hasText: vaultName });
    await vaultItem.locator('.vm-vault-publish').click({ timeout: 5_000 });
    await expect(page.locator('.publish-overlay')).toBeVisible({ timeout: 5_000 });

    const fields = page.locator('.publish-form .publish-field input'); // [0]=名称 [1]=简介
    await fields.nth(0).fill(resourceName);
    await fields.nth(1).fill('E2E 自动发布的社区资源，用于 P1 门禁验证');
    await page.locator('.publish-preview-add input[type="file"]').setInputFiles({
      name: 'preview-1x1.png',
      mimeType: 'image/png',
      buffer: PNG_1PX,
    });
    await expect(page.locator('.publish-preview-item')).toHaveCount(1);
    await page.locator('.publish-agreement input[type="checkbox"]').check();
    await page.locator('.publish-footer .kb-btn-primary').click();
    // 成功态（文案 publish.done）；打包 + 直传 + confirm 全在本地，秒级但留足余量
    await expect(page.locator('.publish-done')).toContainText('发布成功', { timeout: 30_000 });
    await page.locator('.publish-footer .kb-btn-primary').click(); // done 态主按钮 = 关闭
    await expect(page.locator('.publish-overlay')).not.toBeVisible();

    // 仓库管理器是全屏模态（.vm-overlay），点其空白处关闭，露出 NavRail
    await page.locator('.vm-overlay').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.vm-overlay')).not.toBeVisible();

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
    await expect(
      page.locator(`[data-testid="resource-badge-community-${listingId}"]`),
    ).toBeVisible();

    await page.locator('[data-testid="resources-filter-community"]').click();
    await expect(card).toBeVisible();

    // 5) 详情页（社区变体）：预览图渲染 + 下载按钮 + 社区说明/举报入口
    await page.locator(`[data-testid="resource-detail-link-${listingId}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${listingId}$`));
    await expect(page.locator('.resources-detail-head h1')).toHaveText(resourceName);
    await expect(
      page.locator(`[data-testid="resource-badge-community-${listingId}"]`),
    ).toBeVisible();

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
    await expect(page.locator('[data-testid="resources-community-note"]')).toBeVisible();
    await expect(page.locator('[data-testid="resources-report-link"]')).toBeVisible();

    // 6) 点下载：新开页导航指向 mock OSS 的签名 GET（zip 键 + Signature）
    const popupPromise = page.context().waitForEvent('page', { timeout: 15_000 });
    const ossReqPromise = page.context().waitForEvent('request', {
      predicate: (r) => r.url().startsWith(`${MOCK_OSS}/`),
      timeout: 15_000,
    });
    await page.locator(`[data-testid="resource-buy-${listingId}"]`).click();
    const [popup, ossReq] = await Promise.all([popupPromise, ossReqPromise]);
    expect(ossReq.url()).toContain(`${MOCK_OSS}/resources/${listingId}-vault.zip`);
    expect(ossReq.url()).toContain('Signature='); // 预签名 GET，非裸链
    await popup.close().catch(() => {});
  });

  test('未登录：资源页可浏览，下载拉起登录门槛', async ({ page, request }) => {
    test.setTimeout(60_000);

    // 全部用例共享同一 daemon 登录态：先清掉上个用例残留的登录
    const status = (await (await request.get('/api/auth/status')).json()) as {
      loggedIn?: boolean;
    };
    if (status.loggedIn) await request.post('/api/auth/logout');

    // 浏览可用：未登录也能看官方货架
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();
    expect(await page.locator('[data-testid^="resource-card-"]').count()).toBeGreaterThan(0);

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
});
