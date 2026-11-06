/**
 * @area kb
 * @priority P1
 *
 * 文件树「看不见」的两条回归：
 * 1) 搜索无匹配时不能只留一片空白 —— 新建/导入不会清空搜索词，过滤态下操作成功
 *    却什么都看不见。空态要说明原因并给一键清空。
 * 2) 空白区右键「刷新目录」重新拉树，并给出「目录已刷新」反馈。
 *
 * 前置：`pnpm dev` running (daemon :3100, web :5173)。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB tree — search empty state & manual refresh', () => {
  // 首次导航要等 vite 冷启动把模块图优化完（CI/本地首次跑常见 >30s）。
  test.describe.configure({ timeout: 60_000 });

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-tree-refresh-search');
    // createTempVault seeds test.md — drop it so the root only has alpha.md.
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# alpha\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('搜索无匹配：给出提示并可一键清空', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.kb-tree-item').first()).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('kb-tree-search').fill('zzz-no-such-file');
    const empty = page.getByTestId('kb-tree-search-empty');
    await expect(empty).toBeVisible({ timeout: 5_000 });
    await expect(empty).toContainText('当前搜索无匹配');

    await page.getByTestId('kb-tree-search-clear').click();
    await expect(page.getByTestId('kb-tree-search-empty')).toHaveCount(0);
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' })).toBeVisible();
  });

  test('空白区右键「刷新目录」重新拉树并提示', async ({ page }) => {
    await page.goto(`/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.kb-tree-item').first()).toBeVisible({ timeout: 10_000 });

    // 外部落盘一个新文件：watcher 也会推送，但这里断言的是「刷新目录」这次请求。
    fs.writeFileSync(path.join(vault.path, 'from-outside.md'), '# outside\n');

    const box = await page.locator('.kb-tree-scroll').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 24, box!.y + box!.height - 8, { button: 'right' });
    await expect(page.getByTestId('kb-ctx-refresh-tree')).toBeVisible({ timeout: 5_000 });

    const treeResponse = page.waitForResponse(
      (r) =>
        r.url().includes('/api/knowledge/vaults/') &&
        r.url().endsWith('/tree') &&
        r.request().method() === 'GET',
      { timeout: 10_000 },
    );
    await page.getByTestId('kb-ctx-refresh-tree').click();
    expect((await treeResponse).status()).toBe(200);

    await expect(page.getByTestId('kb-notice')).toContainText('目录已刷新');
    await expect(
      page.locator('.kb-tree-item').filter({ hasText: 'from-outside.md' }),
    ).toBeVisible({ timeout: 10_000 });
  });
});