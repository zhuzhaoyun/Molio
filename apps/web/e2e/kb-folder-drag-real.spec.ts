/**
 * @area kb-import
 * @priority P1
 *
 * Real mouse-based drag test for folder move — not synthetic events.
 * Verifies the actual on-disk move happens end-to-end. Regression coverage:
 *   1. stale-closure bug — `kb.activeVault` was null during the initial
 *      vault-auto-select window; fix reads from vaultStore at call time.
 *   2. dragStart-bubbling bug — subfolder dragStart bubbled to its parent
 *      folder's group and overwrote `text/plain` with the parent's path,
 *      so dragging a nested subfolder also moved its parent.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB folder drag (real mouse)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-folder-drag-real');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.mkdirSync(path.join(vault.path, 'folderA'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'folderA', 'a.txt'), 'a\n');
    fs.mkdirSync(path.join(vault.path, 'folderB'), { recursive: true });
    // Nested case: folderA/subA — dragging subA must NOT drag folderA along.
    fs.mkdirSync(path.join(vault.path, 'folderA', 'subA'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'folderA', 'subA', 'sub.txt'), 'sub\n');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  // Run nested test FIRST — leaves folderA at root for the simple test to drag.
  test('drag nested subA onto folderB moves only subA (not its parent)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    // Expand folderA so subA is visible & draggable.
    const folderA = page.locator('.kb-tree-group-label').filter({ hasText: 'folderA' });
    await folderA.click();
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'subA' }),
    ).toBeVisible({ timeout: 10_000 });

    const src = page.locator('.kb-tree-group-label').filter({ hasText: 'subA' });
    const dest = page.locator('.kb-tree-group-label').filter({ hasText: 'folderB' });

    const srcBox = await src.boundingBox();
    const destBox = await dest.boundingBox();
    expect(srcBox && destBox).toBeTruthy();

    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2 + 5, srcBox!.y + 5, { steps: 3 });
    await page.mouse.move(destBox!.x + destBox!.width / 2, destBox!.y + destBox!.height / 2, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(2000);

    // subA moved into folderB
    expect(fs.existsSync(path.join(vault.path, 'folderB', 'subA', 'sub.txt'))).toBe(true);
    // subA gone from folderA
    expect(fs.existsSync(path.join(vault.path, 'folderA', 'subA'))).toBe(false);
    // CRITICAL: folderA itself must NOT have moved — the pre-fix bug had
    // dragstart bubble up to folderA's group and overwrite text/plain, so
    // folderA (not subA) was the one renamed.
    expect(fs.existsSync(path.join(vault.path, 'folderA'))).toBe(true);
    expect(fs.existsSync(path.join(vault.path, 'folderA', 'a.txt'))).toBe(true);
  });

  test('drag folderA onto folderB moves it on disk', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'folderA' }),
    ).toBeVisible({ timeout: 10_000 });

    const src = page.locator('.kb-tree-group-label').filter({ hasText: 'folderA' });
    const dest = page.locator('.kb-tree-group-label').filter({ hasText: 'folderB' });

    const srcBox = await src.boundingBox();
    const destBox = await dest.boundingBox();
    expect(srcBox && destBox).toBeTruthy();

    // Drag immediately (within the vault-auto-select stale-closure window)
    // to verify the fix reads from vaultStore at call time.
    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2 + 5, srcBox!.y + 5, { steps: 3 });
    await page.mouse.move(destBox!.x + destBox!.width / 2, destBox!.y + destBox!.height / 2, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(2000);

    const moved = fs.existsSync(path.join(vault.path, 'folderB', 'folderA', 'a.txt'));
    const oldGone = !fs.existsSync(path.join(vault.path, 'folderA'));
    expect(moved).toBe(true);
    expect(oldGone).toBe(true);
  });
});
