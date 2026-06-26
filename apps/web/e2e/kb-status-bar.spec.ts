import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB Status Bar', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-status-bar');
    // Write explicit doc.md with known CJK + English content so both word
    // counting paths are exercised and the test does not depend on the
    // implicit test.md fixture from createTempVault.
    fs.writeFileSync(
      path.join(vault.path, 'doc.md'),
      '# 标题\n\n这是用于统计字数的文档内容 hello world\n',
    );
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('shows word/char/read-time stats when a file is open', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Wait for the file tree to load, then click doc.md
    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'doc.md' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });
    await fileNode.click();

    const statusBar = page.locator('[data-testid="kb-status-bar"]');
    await expect(statusBar).toBeVisible({ timeout: 10_000 });
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