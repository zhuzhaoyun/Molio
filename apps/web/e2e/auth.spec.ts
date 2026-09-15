/**
 * @area auth
 * @priority P1
 *
 * E2E tests for the account panel + verification-code login (design §7.4 / M3).
 *
 * Red line under test: the Web UI only talks to the daemon mirror endpoints
 * (/api/auth/*); the verification code is captured from the /api/auth/start
 * response's `devCode` field (only returned by daily/local cloud — the UI
 * itself never displays it).
 *
 * Degradation: since auth.molio.cn went live the daemon has a built-in
 * default URL, so `configured` is false only when MOLIO_AUTH_URL is
 * explicitly blanked; the login-chain tests probe GET /api/auth/status
 * `configured` and skip in that case (and skip when a prod-mode cloud
 * returns no devCode). The modal open/close test always runs.
 *
 * Prerequisites: `pnpm dev` — or let playwright webServer start cloud (:3200)
 * + daemon (with MOLIO_AUTH_URL injected, see playwright.config.ts).
 */

import { test, expect, type Page } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

const ACCOUNT_MODAL = '.account-modal';

function uniqueEmail(tag: string): string {
  return `molio-e2e-${tag}-${Date.now()}@example.com`;
}

async function openAccount(page: Page) {
  await page.locator('[data-testid="nav-account-btn"]').click();
  await expect(page.locator(ACCOUNT_MODAL)).toBeVisible();
}

/**
 * Drive the UI through email → send code → verify. The code comes from
 * the daemon-passed devCode (waitForResponse), NOT from any UI element.
 */
async function sendCodeAndVerify(page: Page, email: string) {
  await page.locator('[data-testid="account-email-input"]').fill(email);
  // Terms consent gates the login flow (design §12 compliance):
  // send-code stays disabled until the checkbox is ticked
  await expect(page.locator('[data-testid="account-send-code-btn"]')).toBeDisabled();
  await page.locator('[data-testid="account-agree-checkbox"]').check();
  const startResp = page.waitForResponse(
    (r) => r.url().includes('/api/auth/start') && r.request().method() === 'POST',
  );
  await page.locator('[data-testid="account-send-code-btn"]').click();
  const body = (await (await startResp).json()) as { devCode?: string };
  if (typeof body.devCode !== 'string') {
    test.skip(true, 'cloud did not return devCode (prod-mode cloud) — cannot fetch code in E2E');
  }
  await expect(page.locator('[data-testid="account-notice"]')).toBeVisible();
  await page.locator('[data-testid="account-code-input"]').fill(body.devCode as string);
  await page.locator('[data-testid="account-verify-btn"]').click();
  await expect(page.locator('[data-testid="account-logged-email"]')).toHaveText(email, {
    timeout: 10_000,
  });
}

async function loginViaUi(page: Page, email: string) {
  // 未登录打开面板即邮箱验证表单（无中间欢迎页），直接填码登录
  await openAccount(page);
  await sendCodeAndVerify(page, email);
}

test.describe('Account panel (always available)', () => {
  // 这组用例断言的是「未登录」形态（登录按钮/登录视图）：其他 spec（如 resources
  // 的登录门槛用例）跑完可能残留登录态，先清掉，避免面板显示登录态资料卡
  test.beforeEach(async ({ request }) => {
    const res = await request.get('/api/auth/status');
    const status = (await res.json()) as { loggedIn?: boolean };
    if (status.loggedIn) await request.post('/api/auth/logout');
  });

  test('account modal opens from nav rail and closes', async ({ page }) => {
    await gotoHome(page);
    await openAccount(page);
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();
  });

  // Regression (2026-08-31): 遮罩（卡片外暗区）点击曾直接关闭面板——用户在验证码
  // 步骤等邮件时误点弹窗外，已输入的邮箱/验证码全部丢失。现在只认右上角 ×。
  test('clicking the overlay backdrop does not close the account modal', async ({
    page,
  }) => {
    await gotoHome(page);
    await openAccount(page);
    // overlay 全屏铺满、模态卡居中：左上角坐标必落在遮罩自身区域
    await page
      .locator('.kb-overlay:has(.account-modal)')
      .click({ position: { x: 12, y: 12 } });
    await expect(page.locator(ACCOUNT_MODAL)).toBeVisible();
    // 表单状态未丢：邮箱输入框仍在（验证码步骤同理，共用同一遮罩）
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();
    // × 仍是有效关闭入口
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();
  });

  // Regression (2026-08-17): base.css 的全局 input{width:100%} 曾把协议勾选框
  // 撑满整行——勾选框居中、协议文案被挤出模态框右边界不可见。
  test('terms row: checkbox stays compact and links fit inside the modal', async ({
    page,
  }) => {
    await gotoHome(page);
    await openAccount(page);

    const checkbox = page.locator('[data-testid="account-agree-checkbox"]');
    await expect(checkbox).toBeVisible();
    const box = await checkbox.boundingBox();
    expect(box).not.toBeNull();
    // 原生勾选框 ~13px；被 width:100% 撑开时会接近模态框宽度（400px）
    expect(box!.width).toBeLessThanOrEqual(30);

    const modalBox = await page.locator(ACCOUNT_MODAL).boundingBox();
    const termsLink = page.locator('a[href="https://molio.cn/terms.html"]');
    await expect(termsLink).toBeVisible();
    const linkBox = await termsLink.boundingBox();
    expect(modalBox).not.toBeNull();
    expect(linkBox).not.toBeNull();
    expect(linkBox!.x).toBeGreaterThanOrEqual(modalBox!.x);
    expect(linkBox!.x + linkBox!.width).toBeLessThanOrEqual(
      modalBox!.x + modalBox!.width + 1,
    );
  });
});

test.describe('Login chain (requires configured daemon)', () => {
  test.beforeEach(async ({ page, request }) => {
    const res = await request.get('/api/auth/status');
    const status = (await res.json()) as { configured?: boolean; loggedIn?: boolean };
    if (!status.configured) {
      test.skip(true, 'daemon MOLIO_AUTH_URL not configured — login chain unavailable');
    }
    // Clean any leftover session (reused local daemon keeps tokens across runs)
    if (status.loggedIn) await request.post('/api/auth/logout');
    await gotoHome(page);
  });

  test('logged-out panel shows the email verification form directly', async ({ page }) => {
    await openAccount(page);
    // 点账号入口直达邮箱验证表单——没有中间欢迎页/额外 CTA
    await expect(page.locator('.account-login-title')).toBeVisible();
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="account-agree-checkbox"]')).toBeVisible();
  });

  test('auto-nickname shown after login; entitlement row shows free plan', async ({
    page,
  }) => {
    const email = uniqueEmail('nick');
    await loginViaUi(page, email);

    // 登录成功（非登录意图）→ 自动导航「我的」页面
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.locator('[data-testid="me-page"]')).toBeVisible();

    // 隐式注册自动生成「墨友 + 4 位随机数」
    const nickname = page.locator('[data-testid="account-nickname"]');
    await expect(nickname).toBeVisible();
    await expect(nickname).toHaveText(/^墨友\d{4}$/, { timeout: 10_000 });

    // 权益行：第一期 plan=free → 显示「免费版 / Free」
    await expect(page.locator('[data-testid="account-entitlement-value"]')).toHaveText(
      /免费版|Free/,
    );
  });

  test('nickname inline edit persists and survives leaving and returning to /me', async ({
    page,
  }) => {
    const email = uniqueEmail('edit');
    await loginViaUi(page, email);
    await expect(page.locator('[data-testid="account-nickname"]')).toBeVisible();

    await page.locator('[data-testid="account-nickname-edit-btn"]').click();
    const input = page.locator('[data-testid="account-nickname-input"]');
    await expect(input).toBeVisible();
    await input.fill('E2E 墨流君');
    await page.locator('[data-testid="account-nickname-save-btn"]').click();

    // 保存成功 → 回展示态，新昵称立刻可见（daemon 已同步本地快照）
    const nickname = page.locator('[data-testid="account-nickname"]');
    await expect(nickname).toHaveText('E2E 墨流君', { timeout: 10_000 });
    await expect(input).not.toBeVisible();

    // 离开再回到 /me 仍是新昵称（数据源 = daemon 本地 token/权益快照）
    await page.locator('[data-view="home"]').click();
    await expect(page.locator('[data-testid="me-page"]')).not.toBeVisible();
    await page.locator('[data-testid="nav-account-btn"]').click();
    await expect(page.locator('[data-testid="account-nickname"]')).toHaveText('E2E 墨流君');
  });

  // 回归（2026-08-24）：邮箱无格式校验时「dd」也能点发送验证码。
  // 客户端先行拦截：输入不像邮箱时发送按钮保持禁用（云端 400 仍是兜底）。
  test('send-code stays disabled until email looks valid', async ({ page }) => {
    await openAccount(page);
    await page.locator('[data-testid="account-agree-checkbox"]').check();
    const emailInput = page.locator('[data-testid="account-email-input"]');
    const sendBtn = page.locator('[data-testid="account-send-code-btn"]');
    await emailInput.fill('dd');
    await expect(sendBtn).toBeDisabled();
    await emailInput.fill('dd@');
    await expect(sendBtn).toBeDisabled();
    await emailInput.fill('dd@example');
    await expect(sendBtn).toBeDisabled();
    await emailInput.fill('dd@example.com');
    await expect(sendBtn).toBeEnabled();
  });

  test('login with verification code, then logout', async ({ page }) => {
    const email = uniqueEmail('login');
    await loginViaUi(page, email);

    // Nav rail account button lights up (logged-in dot)
    await expect(page.locator('[data-testid="nav-account-btn"]')).toHaveClass(/is-logged-in/);

    // Logout（/me 资料 Tab）— local tokens cleared, page falls back to inline login form
    await expect(page).toHaveURL(/\/me$/);
    await page.locator('[data-testid="account-logout-btn"]').click();
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-account-btn"]')).not.toHaveClass(/is-logged-in/);
  });

  test('wrong verification code shows an error', async ({ page }) => {
    const email = uniqueEmail('badcode');
    await openAccount(page);

    await page.locator('[data-testid="account-email-input"]').fill(email);
    await page.locator('[data-testid="account-agree-checkbox"]').check();
    const startResp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/start') && r.request().method() === 'POST',
    );
    await page.locator('[data-testid="account-send-code-btn"]').click();
    const body = (await (await startResp).json()) as { devCode?: string };
    if (typeof body.devCode !== 'string') {
      test.skip(true, 'cloud did not return devCode (prod-mode cloud) — cannot fetch code in E2E');
    }

    const wrong = body.devCode === '000000' ? '111111' : '000000';
    await page.locator('[data-testid="account-code-input"]').fill(wrong);
    await page.locator('[data-testid="account-verify-btn"]').click();
    await expect(page.locator('[data-testid="account-error"]')).toBeVisible();
    // Still on the code step, not logged in
    await expect(page.locator('[data-testid="account-code-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-account-btn"]')).not.toHaveClass(/is-logged-in/);
  });

  // 「我的已购」Tab（/me?tab=purchases）：daemon 镜像 /api/market/purchases →
  // 列表 + 下载（下载走 /api/market/listings/:id/download 拿最新版签名 URL）。
  // E2E 环境 cloud 未配市场 OSS 凭证，daemon 镜像端点用 page.route mock。
  test('my-purchases tab lists purchases and re-downloads via signed URL', async ({ page }) => {
    const email = uniqueEmail('purchases');
    await loginViaUi(page, email);

    await page.route('**/api/market/purchases', (route) =>
      route.fulfill({
        json: {
          purchases: [
            {
              id: 'l1',
              purchasedAt: '2026-09-01T08:00:00.000Z',
              listing: { name: '史记研读库', icon: '📖', tint: '#E8EDF2', version: 'v1.2', priceCents: 1990, summary: 's' },
              available: true,
            },
            { id: 'l2', purchasedAt: null, listing: null, available: false },
          ],
        },
      }),
    );
    let downloadHits = 0;
    await page.route('**/api/market/listings/l1/download', (route) => {
      downloadHits++;
      return route.fulfill({ json: { url: 'https://oss.local/signed-latest.zip', expiresAt: 0 } });
    });
    // 拦截 window.open：不真开新页，只记录 URL
    await page.evaluate(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((u: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(u);
        return null;
      }) as typeof window.open;
    });

    await page.locator('[data-testid="me-tab-purchases"]').click();
    await expect(page).toHaveURL(/\/me\?tab=purchases/);
    const section = page.locator('[data-testid="my-purchases-section"]');
    await expect(section).toBeVisible();
    await expect(page.locator('[data-testid="my-purchases-item"]')).toHaveCount(2);
    await expect(section).toContainText('史记研读库');
    await expect(section).toContainText('v1.2');
    // 已下架条目：显示占位名 + 下载按钮禁用
    await expect(section).toContainText(/资源已下架|Resource removed/);
    const buttons = page.locator('[data-testid="my-purchases-download-btn"]');
    await expect(buttons.nth(1)).toBeDisabled();

    // 可用条目点击下载 → 请求签名 URL → window.open
    await buttons.nth(0).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __opened: string[] }).__opened),
      )
      .toEqual(['https://oss.local/signed-latest.zip']);
    expect(downloadHits).toBe(1);

    // 切回资料 Tab：URL 复位、资料卡可见
    await page.locator('[data-testid="me-tab-profile"]').click();
    await expect(page).toHaveURL(/\/me$/);
    await expect(page.locator('[data-testid="account-profile"]')).toBeVisible();
  });

});
