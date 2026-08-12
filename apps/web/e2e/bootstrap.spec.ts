import { test, expect } from '@playwright/test';
import { gotoHome, waitForLanding } from './helpers/navigation';

/**
 * @area navigation
 * @priority P0
 *
 * E2E tests for app bootstrap and first render.
 *
 * Verifies that the application loads correctly, the landing page renders,
 * the composer is available, and the navigation rail shows all expected items.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('App bootstrap', () => {
  test('app loads and shows landing page', async ({ page }) => {
    await gotoHome(page);

    await expect(page.locator('.home-landing')).toBeVisible();
    await expect(page.locator('[data-testid="hero-brand"]')).toContainText('Molio');
  });

  test('composer is visible and ready', async ({ page }) => {
    await gotoHome(page);

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible();
  });

  test('nav rail shows all navigation items', async ({ page }) => {
    await gotoHome(page);

    const nav = page.locator('.entry-nav-rail');
    await expect(nav).toBeVisible();

    // Verify all nav items are present (home, knowledge, graph, resources, history, settings, help)
    const expectedViews = ['home', 'knowledge', 'graph', 'resources', 'history', 'settings', 'help'];
    for (const view of expectedViews) {
      await expect(page.locator(`[data-view="${view}"]`)).toBeVisible();
    }
  });

  test('hero shows tagline', async ({ page }) => {
    await gotoHome(page);
    await waitForLanding(page);

    await expect(page.locator('[data-testid="hero-tagline"]')).toBeVisible();
  });
});
