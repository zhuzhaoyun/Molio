import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area graph
 * @priority P1
 *
 * E2E tests for the Graph (knowledge graph) page.
 *
 * Graph rendering depends on the PixiJS (WebGL) engine — these tests verify
 * page structure and state display rather than pixel-perfect rendering.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Graph', () => {
  test('page loads and shows graph page shell', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });
  });

  test('shows empty state or canvas when no vault selected', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Without a vault, should show either empty state or a canvas with no data
    const emptyState = page.locator('.graph-empty');
    const canvas = page.locator('.graph-canvas');

    // At least one of these should be visible
    const hasEmpty = await emptyState.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasCanvas = await canvas.isVisible({ timeout: 1_000 }).catch(() => false);

    expect(hasEmpty || hasCanvas).toBe(true);
  });

  test('canvas container or empty state exists in graph page', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // When no vault is selected, .graph-empty is shown instead of .graph-canvas.
    // When a vault is selected, .graph-canvas exists. At least one must be present.
    const canvas = page.locator('.graph-canvas');
    const emptyState = page.locator('.graph-empty');
    const hasCanvas = await canvas.isVisible({ timeout: 3_000 }).catch(() => false);
    const hasEmpty = await emptyState.isVisible({ timeout: 1_000 }).catch(() => false);
    expect(hasCanvas || hasEmpty).toBe(true);
  });
});
