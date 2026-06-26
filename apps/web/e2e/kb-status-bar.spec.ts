import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB Status Bar', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-status-bar');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('shows word/char/read-time stats when a file is open', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Wait for the file tree to load, then click test.md
    await page.waitForTimeout(1500);
    const testFile = page.locator('.kb-tree-item').filter({ hasText: 'test.md' });
    if (await testFile.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await testFile.click();
    }

    const statusBar = page.locator('[data-testid="kb-status-bar"]');
    await expect(statusBar).toBeVisible({ timeout: 10_000 });
    // "Hello" and "world" are English words in test.md content
    await expect(statusBar).toContainText('字数', { timeout: 5_000 });
    await expect(statusBar).toContainText('字符');
    await expect(statusBar).toContainText('分钟');
  });

  test('hidden when no file is selected', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // Status bar should not appear when no file is selected
    await expect(page.locator('[data-testid="kb-status-bar"]')).toHaveCount(0);
  });
});