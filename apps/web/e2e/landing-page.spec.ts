import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockAgent } from './helpers/mock-sse';

test.describe('Landing page', () => {
  // Mock a usable agent so the composer renders regardless of the CI runner
  // having no runtime installed (otherwise the NoRuntimeCard replaces it).
  test.beforeEach(async ({ page }) => {
    await mockAgent(page);
  });

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

});

