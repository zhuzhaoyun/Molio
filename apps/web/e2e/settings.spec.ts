import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area settings
 * @priority P1
 *
 * E2E tests for the Settings page.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Settings', () => {
  test('page loads with language section visible', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="lang-zh"]')).toBeVisible();
  });

  test('language pills are displayed with one active', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    // Language pills: zh + en, exactly one active
    await expect(page.locator('[data-testid^="lang-"]')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('[data-testid^="lang-"].is-active')).toHaveCount(1);
  });

  test('switching language changes active pill', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    const inactiveLang = page.locator('[data-testid^="lang-"]:not(.is-active)').first();
    if (await inactiveLang.isVisible()) {
      const testid = await inactiveLang.getAttribute('data-testid');
      await inactiveLang.click();
      await page.waitForTimeout(500);

      // The clicked pill should now be active
      await expect(page.locator(`[data-testid="${testid}"]`)).toHaveClass(/is-active/);
    }
  });
});
