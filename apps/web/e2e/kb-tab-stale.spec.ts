import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Stale tab cleanup (#4) + same-name disambiguation (#5).
 */

let vault: TempVault;

test.describe('KB stale tab cleanup (proactive)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-stale');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.mkdirSync(path.join(vault.path, 'sub1'));
    fs.writeFileSync(path.join(vault.path, 'sub1/a.md'), '# A\n');
    fs.mkdirSync(path.join(vault.path, 'sub2'));
    fs.writeFileSync(path.join(vault.path, 'sub2/b.md'), '# B\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  const openTab = async (page: import('@playwright/test').Page, name: string) => {
    await page.locator('.kb-tree-item').filter({ hasText: name }).click();
  };
  const expandFolder = async (page: import('@playwright/test').Page, name: string) => {
    await page.locator('.kb-tree-group-label').filter({ hasText: name }).click();
  };
  const ctxRename = async (page: import('@playwright/test').Page, name: string, newName: string) => {
    await page.locator('.kb-tree-item').filter({ hasText: name }).click({ button: 'right' });
    await page.locator('.ctx-menu-item', { hasText: '重命名' }).click();
    const input = page.locator('.kb-tree-rename-input');
    await expect(input).toBeVisible({ timeout: 3_000 });
    await input.fill(newName);
    await input.press('Enter');
  };

  test('renaming an open tab file updates the tab, keeps active', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' })).toBeVisible({ timeout: 10_000 });
    await openTab(page, 'alpha.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await ctxRename(page, 'alpha.md', 'alpha-renamed.md');
    // tab still 1, title updated, active
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha-renamed.md');
    // tree shows new name
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha-renamed.md' })).toBeVisible({ timeout: 5_000 });
  });

  test('deleting an open tab file closes the tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openTab(page, 'alpha-renamed.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'alpha-renamed.md' }).click({ button: 'right' });
    await page.locator('.ctx-menu-item', { hasText: '删除' }).click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '删除' }).click();
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.kb-wtab')).toHaveCount(0, { timeout: 5_000 });
  });

  test('deleting a folder closes all tabs under it, leaves others', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expandFolder(page, 'sub1');
    await openTab(page, 'a.md');
    await expandFolder(page, 'sub2');
    await openTab(page, 'b.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });

    // delete sub1 folder
    await page.locator('.kb-tree-group-label').filter({ hasText: 'sub1' }).click({ button: 'right' });
    await page.locator('.ctx-menu-item', { hasText: '删除文件夹' }).click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '删除' }).click();
    await expect(overlay).not.toBeVisible();
    // sub1/a.md tab gone; sub2/b.md stays
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('b.md');
  });
});
