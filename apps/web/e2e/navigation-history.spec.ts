/**
 * @area navigation
 * @priority P1
 *
 * Tests for navigation history: back/forward buttons and navigation tracking.
 *
 * Prerequisites: pnpm dev running on localhost:5173, at least one vault exists.
 */

import { test, expect } from '@playwright/test';

test.describe('Navigation History', () => {
  test('back and forward buttons are rendered in the nav rail', async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('[data-testid="nav-back"]');

    const backBtn = page.locator('[data-testid="nav-back"]');
    const forwardBtn = page.locator('[data-testid="nav-forward"]');

    await expect(backBtn).toBeVisible();
    await expect(forwardBtn).toBeVisible();
  });

  test('back button is disabled on initial page load', async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('[data-testid="nav-back"]');

    const backBtn = page.locator('[data-testid="nav-back"]');
    const forwardBtn = page.locator('[data-testid="nav-forward"]');

    await expect(backBtn).toBeDisabled();
    await expect(forwardBtn).toBeDisabled();
  });

  test('back button becomes enabled after navigating to another page', async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('[data-testid="nav-back"]');

    // Navigate to knowledge base
    await page.locator('[data-view="knowledge"]').click();
    await page.waitForURL('**/knowledge');

    const backBtn = page.locator('[data-testid="nav-back"]');
    await expect(backBtn).toBeEnabled();

    // Forward should be disabled (nothing in forward stack)
    const forwardBtn = page.locator('[data-testid="nav-forward"]');
    await expect(forwardBtn).toBeDisabled();
  });

  test('back button navigates to previous route', async ({ page }) => {
    await page.goto('http://localhost:5173/');
    await page.waitForSelector('[data-testid="nav-back"]');

    // Navigate to history page
    await page.locator('[data-view="history"]').click();
    await page.waitForURL('**/history');

    // Navigate to graph page
    await page.locator('[data-view="graph"]').click();
    await page.waitForURL('**/graph');

    // Click back — should go to history
    await page.locator('[data-testid="nav-back"]').click();
    await page.waitForURL('**/history');

    // Click back again — should go to home
    await page.locator('[data-testid="nav-back"]').click();
    await page.waitForURL('http://localhost:5173/');

    // Forward should be enabled (we went back twice, so 2 entries in forward stack)
    const forwardBtn = page.locator('[data-testid="nav-forward"]');
    await expect(forwardBtn).toBeEnabled();

    // Click forward — should go to history
    await forwardBtn.click();
    await page.waitForURL('**/history');
  });
});
