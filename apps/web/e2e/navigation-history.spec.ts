import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area navigation
 * @priority P1
 *
 * Tab-scoped view history. The forward/back buttons walk the order of views the
 * user has visited in the KB tab workspace — files AND the graph tab (the graph
 * joins the history as a "visited view"; its floating topbar hosts the same
 * chevrons at the same spot as the file title bar). With the #241 tab model
 * (click a file recycles the current tab), back/forward re-open the target via
 * handleSelectFile / openGraphTab — activating an existing tab or recycling the
 * current one — so navigation never grows the tab count from browsing alone.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Navigation history (tabs)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-nav-history');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
    fs.writeFileSync(path.join(vault.path, 'gamma.md'), '# Gamma\n');
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('back/forward buttons render in the KB title bar', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="nav-back"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-forward"]')).toBeVisible();
  });

  test('both buttons are disabled when no file is open yet', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="nav-back"]')).toBeDisabled();
    await expect(page.locator('[data-testid="nav-forward"]')).toBeDisabled();
  });

  test('viewing files then back/forward walks the sequence (recycle, no tab growth)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    const gamma = page.locator('.kb-tree-item').filter({ hasText: 'gamma.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await expect(beta).toBeVisible({ timeout: 10_000 });
    await expect(gamma).toBeVisible({ timeout: 10_000 });

    const activeTitle = () => page.locator('.kb-wtab.is-active');
    const tabCount = () => page.locator('.kb-wtab');

    // View alpha → beta → gamma. The #241 model recycles the current tab, so
    // there is always just ONE tab whose file changes.
    await alpha.click();
    await expect(activeTitle()).toContainText('alpha.md', { timeout: 5_000 });
    await beta.click();
    await expect(tabCount()).toHaveCount(1, { timeout: 5_000 });
    await expect(activeTitle()).toContainText('beta.md');
    await gamma.click();
    await expect(tabCount()).toHaveCount(1);
    await expect(activeTitle()).toContainText('gamma.md');

    // Back ×2 → gamma → beta → alpha (recycling the same tab each time).
    await page.locator('[data-testid="nav-back"]').click();
    await expect(activeTitle()).toContainText('beta.md');
    await expect(tabCount()).toHaveCount(1); // no new tab spawned
    await page.locator('[data-testid="nav-back"]').click();
    await expect(activeTitle()).toContainText('alpha.md');
    await expect(tabCount()).toHaveCount(1);

    // Forward ×2 → beta → gamma.
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(activeTitle()).toContainText('beta.md');
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(activeTitle()).toContainText('gamma.md');
  });

  test('graph tab joins the history; its topbar hosts the same back/forward', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    // 看过 alpha → 打开图谱标签（图谱作为「被看过的视图」入栈）
    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('图谱', { timeout: 5_000 });

    // 图谱顶栏最左有同款前进/后退：后退可用（alpha 在后面），前进不可用（图谱是最新视图）
    await expect(page.locator('[data-testid="graph-nav-back"]')).toBeVisible();
    await expect(page.locator('[data-testid="graph-nav-back"]')).toBeEnabled();
    await expect(page.locator('[data-testid="graph-nav-forward"]')).toBeDisabled();

    // 图谱顶栏后退 → 回到 alpha；文件栏前进 → 回到图谱（闭环）
    await page.locator('[data-testid="graph-nav-back"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('图谱', { timeout: 5_000 });
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
  });

  test('file → graph → file: back/forward walks across view kinds', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await expect(beta).toBeVisible({ timeout: 10_000 });

    // 历史：alpha → 图谱 → beta（图谱标签不可回收，beta 开新标签）
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    await beta.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md', { timeout: 5_000 });

    // 后退 ×2：beta → 图谱 → alpha（跨视图类型行走；图谱顶栏的后退同样可用）
    await page.locator('[data-testid="nav-back"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('图谱', { timeout: 5_000 });
    await expect(page.locator('.graph-page')).toBeVisible();
    await page.locator('[data-testid="graph-nav-back"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });

    // 前进 ×2：alpha → 图谱 → beta
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('图谱', { timeout: 5_000 });
    await page.locator('[data-testid="graph-nav-forward"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md', { timeout: 5_000 });
  });
});
