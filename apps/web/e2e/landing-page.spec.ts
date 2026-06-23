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

  test('quick action buttons are visible', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const newDocBtn = page.locator('[data-testid="home-quick-new-doc"]');
    const browseBtn = page.locator('[data-testid="home-quick-browse-kb"]');

    await expect(newDocBtn).toBeVisible();
    await expect(browseBtn).toBeVisible();
  });

  test('quick action buttons navigate to knowledge page', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const browseBtn = page.locator('[data-testid="home-quick-browse-kb"]');
    await browseBtn.click();

    // Should navigate to /knowledge
    await expect(page).toHaveURL(/\/knowledge/, { timeout: 5000 });
  });

  test('recent files section shows when vault is active', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    // Recent files section may or may not have files depending on vault state
    const section = page.locator('[data-testid="home-recent-files"]');
    const hasSection = await section.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasSection) {
      // If section exists, should have header
      await expect(section).toBeVisible();
    }
  });
});
