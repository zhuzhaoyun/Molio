import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * 阅读视窗滚动位置回归：小 .md 阅读路径的滚动容器 `.kb-content-area` 在切换
 * 文件时被 React 复用（同位置同元素只换 children），scrollTop 会残留上一篇的
 * 位置。KbMainContent 里以 selectedFile 为依赖把容器重置回顶部。
 *
 * Regression for: 在文档 A 翻到中间/底部后切换到文档 B，视窗仍停留在原位置
 * 而不是从 B 的首行开始。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

/** 生成足够撑出滚动条的长文档。 */
function longDoc(title: string, marker: string): string {
  const lines = [`# ${title}`, ''];
  for (let i = 1; i <= 200; i++) {
    lines.push(`段落 ${i}：这是一段用于撑高文档的占位文本，重复多次以确保内容超出视口高度。`);
    lines.push('');
  }
  lines.push(marker);
  return lines.join('\n');
}

test.describe('KB 阅读视窗滚动重置', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-scroll-reset');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'long-a.md'), longDoc('文档 A', 'A 的结尾标记'));
    fs.writeFileSync(path.join(vault.path, 'long-b.md'), longDoc('文档 B', 'B 的结尾标记'));
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('切换到另一篇文档时视窗回到顶部', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const itemA = page.locator('.kb-tree-item').filter({ hasText: 'long-a.md' });
    const itemB = page.locator('.kb-tree-item').filter({ hasText: 'long-b.md' });
    await expect(itemA).toBeVisible({ timeout: 10_000 });
    await expect(itemB).toBeVisible({ timeout: 10_000 });

    const contentArea = page.locator('.kb-content-area');

    // 1. 打开 A，滚到底部。
    await itemA.click();
    await expect(contentArea).toContainText('A 的结尾标记', { timeout: 10_000 });
    await contentArea.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => contentArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

    // 2. 切换到 B —— 视窗必须回到顶部，而不是停在 A 的位置。
    await itemB.click();
    await expect(contentArea).toContainText('B 的结尾标记', { timeout: 10_000 });
    expect(await contentArea.evaluate((el) => el.scrollTop)).toBe(0);

    // 3. 反向再验一次：B 滚到底后切回 A，同样回顶。
    await contentArea.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(() => contentArea.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await itemA.click();
    await expect(contentArea).toContainText('A 的结尾标记', { timeout: 10_000 });
    expect(await contentArea.evaluate((el) => el.scrollTop)).toBe(0);
  });
});
