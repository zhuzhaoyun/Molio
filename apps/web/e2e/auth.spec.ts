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

    // 隐式注册自动生成「墨友 + 4 位随机数」
    const nickname = page.locator('[data-testid="account-nickname"]');
    await expect(nickname).toBeVisible();
    await expect(nickname).toHaveText(/^墨友\d{4}$/, { timeout: 10_000 });

    // 权益行：第一期 plan=free → 显示「免费版 / Free」
    await expect(page.locator('[data-testid="account-entitlement-value"]')).toHaveText(
      /免费版|Free/,
    );
  });

  test('nickname inline edit persists and survives reopening the panel', async ({
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

    // 关闭重开面板仍是新昵称（数据源 = daemon 本地 token/权益快照）
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator(ACCOUNT_MODAL)).not.toBeVisible();
    await openAccount(page);
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

    // Logout — local tokens cleared, panel falls back to the email form
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

});
