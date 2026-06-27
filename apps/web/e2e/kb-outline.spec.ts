import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB Outline Panel', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-outline');
    fs.writeFileSync(
      path.join(vault.path, 'doc.md'),
      '# 顶级标题\n\n## 设计目标\n\n### 性能要求\n\n### 兼容性\n\n## 实现方案\n\n## 测试策略\n',
    );
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('outline lists H2/H3 headings and jumps on click', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Outline is now a direct toolbar button (not behind a menu)
    await page.locator('[data-testid="kb-btn-outline"]').click();

    const panel = page.locator('[data-testid="kb-outline-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('设计目标');
    await expect(panel).toContainText('实现方案');
    await expect(panel).toContainText('测试策略');

    // H3 缩进存在（性能要求）
    const h3 = panel.locator('[data-testid="outline-item"]').filter({ hasText: '性能要求' });
    await expect(h3).toBeVisible();

    // 点击跳转不报错（heading 在渲染区可见）
    await h3.click();
    // 关闭
    await page.locator('[data-testid="kb-outline-close"]').click();
    await expect(panel).not.toBeVisible();
  });
});
