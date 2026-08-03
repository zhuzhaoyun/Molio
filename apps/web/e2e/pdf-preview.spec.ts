/**
 * @area kb
 * @priority P1
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.describe('知识库 PDF 预览', () => {
  let vault: TempVault;

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-pdf-preview');
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'sample.pdf'), path.join(vault.path, 'sample.pdf'));
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('文件树点击 PDF → 内嵌查看器渲染', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'sample.pdf' }).click({ timeout: 10_000 });

    const viewer = page.locator('[data-testid="pdf-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 15_000 });
    // 首页 canvas 渲染
    await expect(viewer.locator('[data-testid="pdf-canvas-1"]')).toBeVisible();
    // 状态条显示第 1 / 2 页
    await expect(viewer.locator('[data-testid="pdf-statusbar"]')).toContainText('第 1 / 2');
    // 文本层有真实文本（1 个 span）
    await expect(viewer.locator('[data-testid="pdf-text-layer-1"] span')).toHaveCount(1);
  });

  test('翻页与缩放按钮生效', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}&file=sample.pdf`);
    await expect(page.locator('[data-testid="pdf-viewer"]')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('kb-btn-pdf-next').click();
    await expect(page.getByTestId('pdf-statusbar')).toContainText('第 2 / 2');

    const before = await page.getByTestId('pdf-statusbar').textContent();
    await page.getByTestId('kb-btn-pdf-zoom-in').click();
    await expect(page.getByTestId('pdf-statusbar')).not.toHaveText(before ?? '');
  });
});
