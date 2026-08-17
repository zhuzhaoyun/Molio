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
 * Degradation: when the (reused local) daemon has no MOLIO_AUTH_URL, the
 * login-chain tests probe GET /api/auth/status `configured` and skip; the
 * modal open/close test always runs.
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
  await openAccount(page);
  await page.locator('[data-testid="account-login-btn"]').click();
  await sendCodeAndVerify(page, email);
}

test.describe('Account panel (always available)', () => {
  test('account modal opens from nav rail and closes', async ({ page }) => {
    await gotoHome(page);
    await openAccount(page);
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
    await page.locator('[data-testid="account-login-btn"]').click();

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

  test('login with verification code, then logout', async ({ page }) => {
    const email = uniqueEmail('login');
    await loginViaUi(page, email);

    // Nav rail account button lights up (logged-in dot)
    await expect(page.locator('[data-testid="nav-account-btn"]')).toHaveClass(/is-logged-in/);

    // Logout — local tokens cleared, back to login CTA
    await page.locator('[data-testid="account-logout-btn"]').click();
    await expect(page.locator('[data-testid="account-login-btn"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-account-btn"]')).not.toHaveClass(/is-logged-in/);
  });

  test('wrong verification code shows an error', async ({ page }) => {
    const email = uniqueEmail('badcode');
    await openAccount(page);
    await page.locator('[data-testid="account-login-btn"]').click();

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

  test('delete account requires explicit acknowledgement', async ({ page }) => {
    const email = uniqueEmail('delete');
    await loginViaUi(page, email);

    await page.locator('[data-testid="account-delete-btn"]').click();
    await expect(page.locator('[data-testid="account-delete-warning"]')).toBeVisible();
    // Confirm is disabled until the acknowledgement checkbox is ticked
    await expect(page.locator('[data-testid="account-delete-confirm-btn"]')).toBeDisabled();
    await page.locator('[data-testid="account-delete-ack"]').check();
    await page.locator('[data-testid="account-delete-confirm-btn"]').click();

    // Cloud soft-delete done → back to logged-out main view
    await expect(page.locator('[data-testid="account-login-btn"]')).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="nav-account-btn"]')).not.toHaveClass(/is-logged-in/);
  });
});
