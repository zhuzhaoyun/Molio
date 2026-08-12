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
