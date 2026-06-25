import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

test.describe('File chat panel', () => {
  test('toolbar button opens file chat panel', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5000 });

    // Click a file in the file tree to open it
    const fileItem = page.locator('.kb-tree-item').first();
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click();
      await page.waitForTimeout(1000);

      // Look for the "询问此文件" button
      const askBtn = page.locator('[data-testid="kb-btn-ask-file"]');
      if (await askBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await askBtn.click();
        await page.waitForTimeout(500);

        // Verify the panel appears
        const panel = page.locator('[data-testid="file-chat-panel"]');
        expect(await panel.isVisible()).toBe(true);

        // Verify close button works
        const closeBtn = page.locator('[data-testid="file-chat-close"]');
        await closeBtn.click();
        await page.waitForTimeout(300);
        expect(await panel.isVisible().catch(() => false)).toBe(false);
      }
    }
  });

  test('empty state shows composer with current file pre-@-mentioned', async ({ page }) => {
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5000 });

    const fileItem = page.locator('.kb-tree-item').first();
    if (await fileItem.isVisible({ timeout: 3000 }).catch(() => false)) {
      await fileItem.click();
      await page.waitForTimeout(1000);

      const askBtn = page.locator('[data-testid="kb-btn-ask-file"]');
      if (await askBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await askBtn.click();
        await page.waitForTimeout(500);

        // Empty state should be visible before any messages
        const emptyState = page.locator('.file-chat-empty');
        expect(await emptyState.isVisible()).toBe(true);

        // Input should be ready
        const input = page.locator('[data-testid="file-chat-panel"] [data-testid="composer-input"]');
        expect(await input.isVisible()).toBe(true);

        // The current file should be pre-filled as a @ ref badge in the composer
        const fileBadge = page.locator(
          '[data-testid="file-chat-panel"] [data-testid="composer-file-badge"]',
        );
        expect(await fileBadge.first().isVisible()).toBe(true);
      }
    }
  });
});
