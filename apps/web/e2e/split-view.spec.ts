import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * KB 单库分屏：右键文件标签 → 分屏预设（图谱对照/文件对照/左右分屏）。
 * 断言结构（pane 可见性/数量），不做像素级断言。
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB split view', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-split-view');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n\n[[beta]]\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n\n[[alpha]]\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  async function openAlpha(page: import('@playwright/test').Page) {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md', { timeout: 5_000 });
  }

  async function splitViaContextMenu(page: import('@playwright/test').Page, testid: string) {
    await page.locator('.kb-wtab.is-active').click({ button: 'right' });
    await expect(page.locator(`[data-testid="${testid}"]`)).toBeVisible({ timeout: 5_000 });
    await page.locator(`[data-testid="${testid}"]`).click();
  }

  test('图谱对照: companion pane shows graph, main pane keeps the file', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-graph');

    const companion = page.locator('[data-testid="kb-companion-pane"]');
    await expect(companion).toBeVisible();
    await expect(companion.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    // 关闭 × 已并入图谱自己的悬浮 topbar（不再有独立副格标题栏）
    await expect(companion.locator('[data-testid="companion-close"]')).toBeVisible();
    // 导航（前进/后退）是主格专属：副格图谱不渲染顶栏箭头，避免「右边点、左边变」误导
    await expect(companion.locator('[data-testid="graph-nav-navigation"]')).toHaveCount(0);
    // 主格文件未被换掉
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');
  });

  test('左右分屏: companion shows the same file (read-only variant)', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-copy');

    const companion = page.locator('[data-testid="kb-companion-pane"]');
    await expect(companion).toBeVisible();
    // 副格是同一文件的只读视图：有文件名头部，动作区只有关闭 ×（无编辑/排版等按钮）
    await expect(companion.locator('.kb-header-filename-center')).toContainText('alpha.md');
    await expect(companion.locator('[data-testid="companion-close"]')).toBeVisible();
    // 导航是主格专属：副格文件头不渲染前进/后退箭头
    await expect(companion.locator('[data-testid="kb-nav-navigation"]')).toHaveCount(0);
  });

  test('文件对照: picker opens and cancel works', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-file');
    // FilePicker 弹层出现；等文件树加载完成（loaded 态才渲染搜索框、Esc 才生效）
    await expect(page.locator('[data-testid="file-picker"]')).toBeVisible();
    // toBeInViewport 而非 toBeVisible：弹层曾被 absolute+bottom:100% 定位飞出视口顶部，
    // 有包围盒但用户看不见——必须断言在视口内
    await expect(page.locator('[data-testid="file-picker-search"]')).toBeInViewport({ timeout: 10_000 });
    // Esc 取消，不产生副格
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="file-picker"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toHaveCount(0);
  });

  test('companion close returns to single view', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-graph');
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toBeVisible();
    await page.locator('[data-testid="companion-close"]').click();
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toHaveCount(0);
    // 回到单视图：主文件 pane 恢复满宽（无 inline right 收窄）
    await expect(page.locator('.kb-pane').first()).not.toHaveClass(/kb-pane--closed/);
  });

  test('normal tab click swaps main pane only (companion preserved), re-split is idempotent', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-graph');
    // 普通点击 beta.md（回收当前未固定标签）→ 主格换文件，副格图谱保留
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await beta.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
    await expect(page.locator('[data-testid="kb-companion-pane"] .graph-page')).toBeVisible();

    // 再右键 → 图谱对照：仍是两格，不产生第 3 格
    await splitViaContextMenu(page, 'tab-split-graph');
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toHaveCount(1);
  });

  test('companion persists across reload', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-graph');
    await page.reload();
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="kb-companion-pane"]')).toBeVisible({ timeout: 10_000 });
  });

  test('graph main tab hides companion (keep-alive), file tab restores it', async ({ page }) => {
    await openAlpha(page);
    await splitViaContextMenu(page, 'tab-split-graph');
    await clickNav(page, 'graph');
    // 主视图=图谱全幅；副格隐藏但仍在 DOM（keep-alive，visibility:hidden）
    await expect(page.locator('.kb-pane--companion')).toHaveClass(/kb-pane--closed/);

    // 回到文件：点树中 beta.md → 图谱标签不可回收 → 开新文件标签 → 副格恢复可见
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await beta.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md', { timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-companion-pane"]:not(.kb-pane--closed)')).toBeVisible();
  });
});
