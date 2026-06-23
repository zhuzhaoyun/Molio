import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';

test.describe('Composer / slash commands', () => {
  test('typing / opens command palette', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();
    await input.click();
    await input.fill('/');

    const palette = page.locator('[data-testid="cmd-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });
    // All 4 commands should be visible initially
    const items = page.locator('[data-testid="cmd-palette-item"]');
    await expect(items).toHaveCount(4);
  });

  test('command palette filters by typed text', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('/new');

    const items = page.locator('[data-testid="cmd-palette-item"]');
    // Should filter to only matching commands
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(4);
  });

  test('command palette closes on Escape', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('/');

    const palette = page.locator('[data-testid="cmd-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(palette).not.toBeVisible();
  });

  test('/new-chat command triggers new chat callback', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('/new-chat');

    const palette = page.locator('[data-testid="cmd-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    // Press Enter to execute
    await page.keyboard.press('Enter');
    // Palette should close after execution
    await expect(palette).not.toBeVisible();
    // The / text should be removed from textarea
    await expect(input).toHaveValue('');
  });

  test('Tab completes polish command into textarea without sending', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const input = page.locator('[data-testid="composer-input"]');
    await input.click();
    await input.fill('/polish');

    const palette = page.locator('[data-testid="cmd-palette"]');
    await expect(palette).toBeVisible({ timeout: 3000 });

    // Tab should complete the command
    await page.keyboard.press('Tab');
    // Palette should close
    await expect(palette).not.toBeVisible();
    // Textarea should contain the polish prompt
    await expect(input).toHaveValue('请帮我优化以下文字的表达，使其更清晰流畅：');
  });
});
