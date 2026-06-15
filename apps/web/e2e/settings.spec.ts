import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * E2E tests for the Settings page.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Settings', () => {
  test('page loads with language section visible', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.settings-language-card')).toBeVisible();
  });

  test('language pills are displayed with one active', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    // Should have at least 2 language pills (zh and en)
    const pills = page.locator('.settings-lang-pill');
    await expect(pills).toHaveCount(2, { timeout: 5_000 });

    // Exactly one should be active
    const activePill = page.locator('.settings-lang-pill.is-active');
    await expect(activePill).toHaveCount(1);
  });

  test('switching language changes active pill', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

    // Find the currently inactive pill and click it
    const pills = page.locator('.settings-lang-pill');
    const inactivePill = pills.filter({ hasNot: page.locator('.is-active') }).first();

    if (await inactivePill.isVisible()) {
      const inactiveText = await inactivePill.textContent();
      await inactivePill.click();
      await page.waitForTimeout(500);

      // The clicked pill should now be active
      await expect(inactivePill).toHaveClass(/is-active/);
    }
  });
});
