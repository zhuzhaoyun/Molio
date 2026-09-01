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
});
