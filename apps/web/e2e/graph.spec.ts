import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area graph
 * @priority P1
 *
 * Knowledge graph as a KB tab. Graph rendering depends on the PixiJS (WebGL)
 * engine, so these are structural assertions (page shell / tab presence), not
 * pixel-perfect rendering.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Graph as tab', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-graph-tab');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('NavRail 图谱 opens a graph tab in the KB workspace', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');

    // 图谱标签被打开并激活 → 图谱 pane 渲染（graph-open 才挂载 GraphPage）
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    // NavRail 图谱按钮在看图谱时高亮（graphViewStore 桥接）
    await expect(page.locator('[data-view="graph"]')).toHaveClass(/is-active/);
  });

  test('graph tab stays mounted (keep-alive) when switching to a file tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });

    // 打开一个文件标签 → 图谱 pane 隐藏但保持挂载（keep-alive），不在 DOM 中被移除
    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    // 图谱 pane 仍在 DOM（挂载、隐藏），证明 keep-alive 而非 re-mount
    await expect(page.locator('.graph-page')).toHaveCount(1);
  });

  test('dark theme: hidden (keep-alive) graph tab must not repaint the main area light', async ({ page }) => {
    // 深色主题在应用加载前写入 localStorage（否则首帧是浅色）
    await page.addInitScript(() => localStorage.setItem('molio.theme', 'dark'));
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    // 图谱标签 keep-alive 常驻：切回文档后 .graph-page 仍在 DOM（仅 visibility:hidden）
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });
    await expect(page.locator('.graph-page')).toHaveCount(1);

    // 回归：图谱画布底曾把 .entry-main 硬编码成 #FAFAFA，且 :has() 只看 DOM 存在性，
    // 于是隐藏的图谱标签也会让文档区整片发白。文档 pane 各层透明，底色就是 .entry-main。
    const bg = await page.locator('.entry-main').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe('rgb(24, 24, 22)'); // --bg（深色）= #181816
  });
});
