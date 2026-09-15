import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * KB tab bar (load-in-current-tab model): clicking a document reuses the
 * CURRENT tab instead of opening a new one; a new tab is created only via the
 * explicit "+" button, the tree right-click「在新标签页中打开」, or right-click
 * the tab bar. Pinned tabs are never recycled by a doc click.
 *
 * Regression for: previously handleSelectFile appended a new tab for every
 * doc, so tab count ballooned to the MAX_TABS cap (20) just from browsing.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB tab bar', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tabs');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
    fs.writeFileSync(path.join(vault.path, 'gamma.md'), '# Gamma\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('open second file reuses the current tab; + creates a fresh tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const alphaItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const betaItem = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    const gammaItem = page.locator('.kb-tree-item').filter({ hasText: 'gamma.md' });
    await expect(alphaItem).toBeVisible({ timeout: 10_000 });
    await expect(betaItem).toBeVisible({ timeout: 10_000 });

    // 1. Open alpha.md — one tab, active.
    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');

    // 2. Open beta.md from the tree — must REUSE the tab (alpha recycled), NOT add.
    await betaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
    expect(await page.locator('.kb-wtab .kb-wtab-title').allTextContents()).toEqual(['beta.md']);

    // 3. "+" explicitly creates a blank tab.
    await page.locator('[data-testid="kb-tab-add"]').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('新标签页');

    // 4. Clicking a file fills the blank tab (no extra tab).
    await gammaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('gamma.md');
    expect(await page.locator('.kb-wtab .kb-wtab-title').allTextContents()).toEqual(['beta.md', 'gamma.md']);

    // 5. Clicking an already-open file activates it (count unchanged).
    await betaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
  });

  test('tree right-click「在新标签页中打开」opens a brand-new tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const alphaItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const betaItem = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alphaItem).toBeVisible({ timeout: 10_000 });

    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await betaItem.click({ button: 'right' });
    await page.locator('[data-testid="kb-ctx-open-in-new-tab"]').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
    expect(await page.locator('.kb-wtab .kb-wtab-title').allTextContents()).toEqual(['alpha.md', 'beta.md']);
  });

  test('double-click pins a tab; a pinned tab is never overwritten by a doc click', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const alphaItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const betaItem = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alphaItem).toBeVisible({ timeout: 10_000 });

    // Open alpha, pin it.
    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await page.locator('.kb-wtab').filter({ hasText: 'alpha.md' }).dblclick();
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(1, { timeout: 3_000 });

    // Click beta — alpha is pinned, so beta opens in a NEW tab; alpha survives.
    await betaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab').filter({ hasText: 'alpha.md' })).toHaveCount(1);
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(1);
  });

  test('double-click does NOT pin the graph tab (pinning only applies to file/blank tabs)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 图谱标签永不回收（per-vault 单例），固定对它无意义：双击不应打 pinned 标记，
    // 与右键菜单对图谱标签隐藏「固定标签」项保持一致。
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 10_000 });
    const graphTab = page.locator('.kb-wtab.is-active');
    await expect(graphTab).toContainText('图谱', { timeout: 5_000 });

    await graphTab.dblclick();
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(0, { timeout: 3_000 });
  });

  test('switching tabs with unsaved edits prompts to discard', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const alphaItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const betaItem = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alphaItem).toBeVisible({ timeout: 10_000 });

    // Open alpha.md, enter typeset mode, make an unsaved edit.
    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-typeset"]').click();
    const textarea = page.locator('.kb-typeset-textarea');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('# Alpha\n\nUNSAVED EDIT MARKER');

    // Click beta.md → unsaved-changes guard must prompt (recycling = switch file).
    await betaItem.click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });

    // Cancel → stay on alpha, edits preserved, still one tab.
    await overlay.locator('button', { hasText: '取消' }).click();
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.kb-wtab')).toHaveCount(1);
    await expect(textarea).toHaveValue(/UNSAVED EDIT MARKER/);

    // Click beta.md again → confirm discard → recycles alpha's tab (still one).
    await betaItem.click();
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '放弃修改并切换' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
  });
});
