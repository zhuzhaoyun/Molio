import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB More Menu', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-more-menu');
    fs.mkdirSync(path.join(vault.path, 'dirA'));
    fs.mkdirSync(path.join(vault.path, 'dirA', 'subA'));
    fs.writeFileSync(path.join(vault.path, 'dirA', 'a.md'), '# A\n');
    fs.writeFileSync(path.join(vault.path, 'dirA', 'subA', 's.md'), '# S\n');
    fs.writeFileSync(path.join(vault.path, 'root.md'), '# Root\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('menu opens and shows all items, Phase 3 disabled', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=root.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-more-menu-btn"]').click();
    const menu = page.locator('[data-testid="kb-more-menu"]');
    await expect(menu).toBeVisible();

    await expect(menu.locator('[data-testid="more-item-outline"]')).toBeVisible();
    await expect(menu.locator('[data-testid="more-item-stats"]')).toBeVisible();
    await expect(menu.locator('[data-testid="more-item-search"]')).toBeVisible();
    await expect(menu.locator('[data-testid="more-item-collapse-all"]')).toBeVisible();

    // Phase 3 项 disabled
    const ai = menu.locator('[data-testid="more-item-ai-summary"]');
    await expect(ai).toBeDisabled();
    await expect(ai).toHaveAttribute('title', /即将上线|Coming soon/);

    // ESC 关闭
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });

  test('collapse all folds expanded directories', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=root.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 先展开 dirA（点击目录标签）
    await page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' }).first().click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'a.md' })).toBeVisible();
    // 展开 subA
    await page.locator('.kb-tree-group-label').filter({ hasText: 'subA' }).first().click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 's.md' })).toBeVisible();

    // 菜单 → 折叠全部
    await page.locator('[data-testid="kb-more-menu-btn"]').click();
    await page.locator('[data-testid="more-item-collapse-all"]').click();

    // subA 的子文件应不再可见
    await expect(page.locator('.kb-tree-item').filter({ hasText: 's.md' })).not.toBeVisible();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'a.md' })).not.toBeVisible();
  });
});
