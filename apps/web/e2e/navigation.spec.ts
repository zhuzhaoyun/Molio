import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * E2E tests for navigation between all main pages.
 *
 * Verifies that every page is reachable via the NavRail and that the
 * active state is correctly highlighted.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Navigation', () => {
  test('navigate to knowledge base', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');

    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/knowledge');
  });

  test('navigate to graph', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/graph');
  });

  test('navigate to history', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'history');

    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/history');
  });

  test('navigate to settings', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/settings');
  });

  test('navigate back to home from another page', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');
    await expect(page.locator('.settings-shell')).toBeVisible();

    // Navigate back to home
    await clickNav(page, 'home');
    await expect(page.locator('.home-page')).toBeVisible();

    // Home nav item should be active
    await expect(page.locator('[data-view="home"]')).toHaveClass(/is-active/);
  });
});
