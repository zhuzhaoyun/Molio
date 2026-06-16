import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * E2E tests for the Channels page.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Channels', () => {
  test('page loads and shows channel list', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'channels');

    await expect(page.locator('.channels-shell')).toBeVisible({ timeout: 5_000 });

    // Channel list should be visible with at least one item
    const list = page.locator('.channels-list');
    await expect(list).toBeVisible();

    const items = page.locator('.channels-list__item');
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
  });

  test('WeChat channel is the default active panel', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'channels');

    await expect(page.locator('.channels-shell')).toBeVisible({ timeout: 5_000 });

    // First channel item should be active (WeChat)
    const firstItem = page.locator('.channels-list__item').first();
    await expect(firstItem).toHaveClass(/is-active/);

    // WeChat card should be visible in the panel
    await expect(page.locator('.channels-card')).toBeVisible();
  });

  test('switching to a planned channel shows empty state', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'channels');

    await expect(page.locator('.channels-shell')).toBeVisible({ timeout: 5_000 });

    // Click on a non-first channel item (e.g., Feishu or WeCom — planned channels)
    const items = page.locator('.channels-list__item');
    const count = await items.count();

    if (count > 1) {
      // Click the second item (should be a planned channel)
      await items.nth(1).click();
      await page.waitForTimeout(500);

      // Should show empty/coming-soon state (.channels-card--empty is the parent card)
      const emptyState = page.locator('.channels-card--empty').first();
      await expect(emptyState).toBeVisible({ timeout: 3_000 });
    }
  });

  test('WeChat panel shows status area', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'channels');

    await expect(page.locator('.channels-shell')).toBeVisible({ timeout: 5_000 });

    // The WeChat card should have a status area and connection dot
    const card = page.locator('.channels-card').first();
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Connection dot should exist
    await expect(card.locator('.channels-dot')).toBeVisible();
  });
});
