import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

test.describe('Landing page', () => {
  test('hero brand and tagline are visible', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    await expect(page.locator('[data-testid="hero-brand"]')).toBeVisible();
    await expect(page.locator('[data-testid="hero-tagline"]')).toBeVisible();
  });

  test('composer is visible on landing page', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
  });

  test('browse knowledge button is visible', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const browseBtn = page.locator('[data-testid="home-quick-browse-kb"]');
    await expect(browseBtn).toBeVisible();
  });

  test('browse knowledge button navigates to knowledge page', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const browseBtn = page.locator('[data-testid="home-quick-browse-kb"]');
    await browseBtn.click();

    await expect(page).toHaveURL(/\/knowledge/, { timeout: 5000 });
  });
});
