import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB Full-text Search', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-search');
    fs.writeFileSync(path.join(vault.path, 'a.md'), '# A\n讨论了微服务拆分的三种方案\n');
    fs.writeFileSync(path.join(vault.path, 'b.md'), '# B\n今天天气不错\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('search via menu shows matching file and opens it', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=a.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-more-menu-btn"]').click();
    await page.locator('[data-testid="more-item-search"]').click();

    const panel = page.locator('[data-testid="kb-search-panel"]');
    await expect(panel).toBeVisible();

    await panel.locator('[data-testid="kb-search-input"]').fill('拆分');
    // 等结果
    await expect(panel.locator('[data-testid="kb-search-result"]')).toHaveCount(1, { timeout: 5_000 });
    await expect(panel.locator('[data-testid="kb-search-result"]')).toContainText('a.md');

    // 点击结果打开文件
    await panel.locator('[data-testid="kb-search-result"]').click();
    // 面板关闭，文件在标签栏打开
    await expect(panel).not.toBeVisible();
    await expect(page.locator('.kb-wtab-title')).toContainText('a.md');
  });

  test('Ctrl+F opens search panel', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=a.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(page.locator('[data-testid="kb-search-panel"]')).toBeVisible();
    // ESC 关闭
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="kb-search-panel"]')).not.toBeVisible();
  });
});
