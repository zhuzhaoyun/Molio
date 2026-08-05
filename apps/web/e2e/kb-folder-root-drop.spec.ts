/**
 * @area kb-import
 * @priority P1
 *
 * Regression for "cannot move a folder/file to the vault root by dropping on
 * empty panel area". Pre-fix: panel-level onDrop early-returned when
 * dataTransfer.files was empty (internal drag), so internal drags dropped on
 * the panel background were silently ignored. Also covers the newPath
 * construction bug where destDir='' produced a leading-slash path.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB drag-to-root (real mouse)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-folder-root-drop');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    // container/subFolder — drag subFolder out to vault root
    fs.mkdirSync(path.join(vault.path, 'container'), { recursive: true });
    fs.mkdirSync(path.join(vault.path, 'container', 'subFolder'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'container', 'subFolder', 'leaf.txt'), 'leaf\n');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('drag subFolder out onto empty panel area moves it to vault root', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    // Expand container so subFolder is visible.
    await page.locator('.kb-tree-group-label').filter({ hasText: 'container' }).click();
    const src = page.locator('.kb-tree-group-label').filter({ hasText: 'subFolder' });
    await expect(src).toBeVisible({ timeout: 10_000 });

    const srcBox = await src.boundingBox();
    expect(srcBox).toBeTruthy();

    // Drop target = empty area at the bottom of the file panel (below all tree
    // nodes). The kb-tree-scroll container is the scrollable tree panel; we
    // aim below the last tree node to land on empty panel background.
    const treeScroll = page.locator('.kb-tree-scroll');
    const treeBox = await treeScroll.boundingBox();
    expect(treeBox).toBeTruthy();

    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2 + 5, srcBox!.y + 5, { steps: 3 });
    // Aim at the bottom of the tree panel (well below any tree node).
    await page.mouse.move(
      treeBox!.x + treeBox!.width / 2,
      treeBox!.y + treeBox!.height - 10,
      { steps: 10 },
    );
    await page.mouse.up();

    await page.waitForTimeout(2000);

    // subFolder now at vault root, leaf.txt carried along.
    expect(fs.existsSync(path.join(vault.path, 'subFolder', 'leaf.txt'))).toBe(true);
    // Gone from container.
    expect(fs.existsSync(path.join(vault.path, 'container', 'subFolder'))).toBe(false);
    // container itself untouched.
    expect(fs.existsSync(path.join(vault.path, 'container'))).toBe(true);
  });
});
