import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area resources
 * @priority P1
 *
 * E2E tests for the resources module (list / filters / detail / not-found).
 *
 * The catalog is bundled from apps/landing-page/resources-data.js (shared
 * single source of truth with the landing page). Counts are asserted
 * relatively (all = paid + free) so adding a resource does not break tests.
 *
 * NOTE: the pay button is intentionally NOT clicked here — it would create
 * real orders against pay.molio.cn. The pay modal is covered manually.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const cards = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="resources-grid"] [data-testid^="resource-card-"]');

test.describe('Resources page', () => {
  test('list renders catalog with filters', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'resources');

    await expect(page.locator('.resources-shell')).toBeVisible();
    const total = await cards(page).count();
    expect(total).toBeGreaterThan(0);

    // filter pills: all / paid / free; counts must satisfy all = paid + free
    await page.locator('[data-testid="resources-filter-paid"]').click();
    const paid = await cards(page).count();

    await page.locator('[data-testid="resources-filter-free"]').click();
    const free = await cards(page).count();
    if (free === 0) {
      await expect(page.locator('.resources-empty')).toBeVisible();
    }

    await page.locator('[data-testid="resources-filter-all"]').click();
    expect(await cards(page).count()).toBe(total);
    expect(total).toBe(paid + free);
  });

  test('navigate to detail and back', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();

    // Enter the first card's detail page
    const firstCard = cards(page).first();
    const firstTestId = await firstCard.getAttribute('data-testid');
    const id = firstTestId!.replace('resource-card-', '');

    await page.locator(`[data-testid="resource-detail-link-${id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${id}$`));
    await expect(page.locator('.resources-detail-head h1')).toBeVisible();
    await expect(page.locator('.resources-section-title').first()).toBeVisible();

    // Back to list
    await page.locator('[data-testid="resources-back"]').click();
    await expect(page).toHaveURL(/\/resources$/);
    await expect(page.locator('[data-testid="resources-grid"]')).toBeVisible();
  });

  test('unknown resource id shows not-found state', async ({ page }) => {
    await gotoHome(page);
    await page.goto('/resources/does-not-exist');

    await expect(page.locator('.resources-shell')).toBeVisible();
    await expect(page.locator('.resources-tip-box')).toBeVisible();
    await expect(page.locator('[data-testid="resources-back"]')).toBeVisible();
  });
});

/**
 * 登录门槛（资源下载/购买不论免费付费都要求登录）：
 * 未登录点购买 → 账号面板直达登录视图（门槛拦在下单之前，不产生任何订单）。
 *
 * ⚠️ 登录后绝不点击购买按钮：PAY_BASE 指向真实支付后端，点击会真实下单。
 * 「登录后自动续接原动作」走手动验证（本地三件套，见实施计划）。
 */
test.describe('Resources login gate', () => {
  test.beforeEach(async ({ page, request }) => {
    const res = await request.get('/api/auth/status');
    const status = (await res.json()) as { loggedIn?: boolean };
    if (status.loggedIn) await request.post('/api/auth/logout');
    await gotoHome(page);
    await clickNav(page, 'resources');
    await expect(page.locator('.resources-shell')).toBeVisible();
  });

  test('logged-out: buy button shows sign-in label and opens login view', async ({ page }) => {
    const firstCard = cards(page).first();
    const id = (await firstCard.getAttribute('data-testid'))!.replace('resource-card-', '');
    const buyBtn = page.locator(`[data-testid="resource-buy-${id}"]`);
    await expect(buyBtn).toHaveText(/登录后/);

    await buyBtn.click();
    // 门槛：账号面板直达登录视图（邮箱输入可见 = login 视图，而非资料主视图）
    await expect(page.locator('.account-modal')).toBeVisible();
    await expect(page.locator('[data-testid="account-email-input"]')).toBeVisible();

    // 取消 = 放弃本次动作，停留资源页，无任何下单副作用
    await page.locator('[data-testid="account-modal-close"]').click();
    await expect(page.locator('.account-modal')).not.toBeVisible();
    await expect(page.locator(`[data-testid="resource-card-${id}"]`)).toBeVisible();
  });

  test('logged-in: buy button drops the sign-in label', async ({ page, request }) => {
    const probe = (await (await request.get('/api/auth/status')).json()) as {
      configured?: boolean;
    };
    if (!probe.configured) {
      test.skip(true, 'daemon MOLIO_AUTH_URL not configured — login chain unavailable');
    }

    // 复用 auth.spec 的 devCode 登录链路（未登录打开面板即邮箱验证表单）
    const email = `molio-e2e-resgate-${Date.now()}@example.com`;
    await page.locator('[data-testid="nav-account-btn"]').click();
    await page.locator('[data-testid="account-email-input"]').fill(email);
    await page.locator('[data-testid="account-agree-checkbox"]').check();
    const startResp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/start') && r.request().method() === 'POST',
    );
    await page.locator('[data-testid="account-send-code-btn"]').click();
    const body = (await (await startResp).json()) as { devCode?: string };
    if (typeof body.devCode !== 'string') {
      test.skip(true, 'cloud did not return devCode (prod-mode cloud)');
    }
    await page.locator('[data-testid="account-code-input"]').fill(body.devCode as string);
    await page.locator('[data-testid="account-verify-btn"]').click();
    await expect(page.locator('[data-testid="account-logged-email"]')).toHaveText(email, {
      timeout: 10_000,
    });
    await page.locator('[data-testid="account-modal-close"]').click();

    // 登录后文案回归正常（未登录前缀消失）。不点击——点击会向真实支付后端下单。
    const firstCard = cards(page).first();
    const id = (await firstCard.getAttribute('data-testid'))!.replace('resource-card-', '');
    await expect(page.locator(`[data-testid="resource-buy-${id}"]`)).not.toHaveText(/登录后/);
  });
});
