import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Tab drag-to-reorder (mouse): pressing a tab and moving past a 4px threshold
 * starts a Chrome-style drag — the tab follows the pointer, siblings glide
 * aside, and the vacated gap is the drop indicator. Drop calls moveTab and the
 * order persists to localStorage. A press without real movement keeps click
 * semantics intact (activate only, no reorder, no swallowed clicks).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173) — or let
 * playwright.config webServer boot them.
 */

let vault: TempVault;

/** Open alpha/beta/gamma as three tabs in order [alpha, beta, gamma]:
 *  click alpha (tab 1), "+" → blank, click beta (fills blank), "+" → blank,
 *  click gamma (fills blank). */
async function openThreeTabs(page: Page) {
  const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
  const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
  const gamma = page.locator('.kb-tree-item').filter({ hasText: 'gamma.md' });
  await expect(alpha).toBeVisible({ timeout: 10_000 });
  await alpha.click();
  await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
  await page.locator('[data-testid="kb-tab-add"]').click();
  await beta.click();
  await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
  await page.locator('[data-testid="kb-tab-add"]').click();
  await gamma.click();
  await expect(page.locator('.kb-wtab')).toHaveCount(3, { timeout: 5_000 });
  await expect(await page.locator('.kb-wtab .kb-wtab-title').allTextContents())
    .toEqual(['alpha.md', 'beta.md', 'gamma.md']);
  // openThreeTabs leaves gamma active — the drag tests pin against this.
  await expect(page.locator('.kb-wtab.is-active')).toContainText('gamma.md');
}

test.describe('KB tab drag-to-reorder', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-drag');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
    fs.writeFileSync(path.join(vault.path, 'gamma.md'), '# Gamma\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('dragging the first tab past the last reorders the strip and persists', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openThreeTabs(page);

    // Drag alpha (first) to the far end: press at its center, sweep past
    // gamma's center so the computed drop index is 2 (the last position).
    const a = page.locator('.kb-wtab').filter({ hasText: 'alpha.md' });
    const g = page.locator('.kb-wtab').filter({ hasText: 'gamma.md' });
    const ab = await a.boundingBox();
    const gb = await g.boundingBox();
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2 + 30, gb.y + gb.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => page.locator('.kb-wtab .kb-wtab-title').allTextContents())
      .toEqual(['beta.md', 'gamma.md', 'alpha.md']);
    // Selection follows the tab, not the position: the drag must NOT change
    // which tab is active (gamma was active when the drag started).
    await expect(page.locator('.kb-wtab.is-active')).toContainText('gamma.md');

    // Order persists across reload (per-vault localStorage).
    await page.reload();
    await expect(page.locator('.kb-wtab').filter({ hasText: 'alpha.md' })).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => page.locator('.kb-wtab .kb-wtab-title').allTextContents())
      .toEqual(['beta.md', 'gamma.md', 'alpha.md']);
  });

  test('press + release without real movement keeps order and click semantics', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openThreeTabs(page);

    // 3px jiggle — below the 4px drag threshold: nothing may reorder.
    const a = page.locator('.kb-wtab').filter({ hasText: 'alpha.md' });
    const ab = await a.boundingBox();
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await page.mouse.down();
    await page.mouse.move(ab.x + ab.width / 2 + 3, ab.y + ab.height / 2, { steps: 2 });
    await page.mouse.up();
    await expect(await page.locator('.kb-wtab .kb-wtab-title').allTextContents())
      .toEqual(['alpha.md', 'beta.md', 'gamma.md']);

    // Click semantics intact — activating another tab still works, and a
    // follow-up click on alpha (whose trailing click might have been flagged
    // for suppression) is not swallowed.
    await page.locator('.kb-wtab').filter({ hasText: 'beta.md' }).click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
    await a.click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');
  });

  test('a pinned tab reorders like any other (pin ≠ position lock)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openThreeTabs(page);

    // Pin alpha, then drag it to the far end.
    const a = page.locator('.kb-wtab').filter({ hasText: 'alpha.md' });
    await a.dblclick();
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(1, { timeout: 3_000 });

    const g = page.locator('.kb-wtab').filter({ hasText: 'gamma.md' });
    const ab = await a.boundingBox();
    const gb = await g.boundingBox();
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await page.mouse.down();
    await page.mouse.move(gb.x + gb.width / 2 + 30, gb.y + gb.height / 2, { steps: 12 });
    await page.mouse.up();

    await expect.poll(() => page.locator('.kb-wtab .kb-wtab-title').allTextContents())
      .toEqual(['beta.md', 'gamma.md', 'alpha.md']);
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(1);
    await expect(page.locator('.kb-wtab.is-pinned')).toContainText('alpha.md');
  });
});
