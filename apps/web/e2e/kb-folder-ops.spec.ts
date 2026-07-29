/**
 * @area kb-import
 * @priority P1
 *
 * Folder-level operations in the KB file tree:
 *   - smoke: drag a folder onto another folder (synthetic DragEvent — headless
 *     Chromium can't carry dataTransfer data across events, so this only
 *     verifies the React handlers don't crash; functional move is covered by
 *     the daemon unit test for renamePath on directories)
 *   - delete-folder confirm dialog shows file/subfolder counts (functional,
 *     verifies Task 3 from issue #45 P0)
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 * Synthetic drag pattern mirrors drag-drop-import.spec.ts.
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB folder operations', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-folder-ops');
    // Remove the seed test.md so the tree only has the structure we build here.
    fs.unlinkSync(path.join(vault.path, 'test.md'));

    // sourceDir/        (with a file + nested subdir — for the count test)
    //   a.txt
    //   b.txt
    //   sub/
    //     c.txt
    // destDir/          (empty, drop target)
    fs.mkdirSync(path.join(vault.path, 'sourceDir'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'sourceDir', 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(vault.path, 'sourceDir', 'b.txt'), 'b\n');
    fs.mkdirSync(path.join(vault.path, 'sourceDir', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'sourceDir', 'sub', 'c.txt'), 'c\n');
    fs.mkdirSync(path.join(vault.path, 'destDir'), { recursive: true });
    // emptyDir/         (for the empty-folder delete case)
    fs.mkdirSync(path.join(vault.path, 'emptyDir'), { recursive: true });
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('smoke: synthetic folder drag does not crash the tree', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'sourceDir' }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'destDir' }),
    ).toBeVisible({ timeout: 5_000 });

    // Synthetic drag-and-drop: dispatch dragstart on sourceDir, then
    // dragover + drop on destDir. Use a FRESH DataTransfer for the drop event
    // so text/plain set by the dragstart React handler doesn't carry into the
    // drop handler — otherwise onMoveFile actually fires and moves sourceDir
    // into destDir on disk, polluting the shared vault state for the count
    // test below. The point of this smoke test is just to verify the React
    // handlers don't throw and the tree stays stable; functional move is
    // covered by the daemon unit test for renamePath on directories.
    const result = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('[data-drop-dir]')) as HTMLElement[];
      const src = groups.find((el) => el.getAttribute('data-drop-dir') === 'sourceDir');
      const dest = groups.find((el) => el.getAttribute('data-drop-dir') === 'destDir');
      if (!src || !dest) return 'src-or-dest-not-found';
      const dtStart = new DataTransfer();
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dtStart }));
      // Fresh empty dt for drop → getData('text/plain') returns '' → onMoveFile
      // early-returns without mutating disk state.
      const dtDrop = new DataTransfer();
      dest.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dtDrop }));
      dest.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dtDrop }));
      return 'ok';
    });
    expect(result).toBe('ok');

    // Tree must remain stable after the (possibly no-op) drop.
    await expect(page.locator('.kb-file-panel')).toBeVisible();
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'sourceDir' }).first(),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'destDir' }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test('delete-folder confirm dialog shows file + subfolder counts', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'sourceDir' }),
    ).toBeVisible({ timeout: 10_000 });

    // Right-click sourceDir label.
    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'sourceDir' });
    await label.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3_000 });

    // Click "删除文件夹" — opens the ConfirmDialog.
    await page.locator('.ctx-menu-item').filter({ hasText: '删除文件夹' }).click();
    const modal = page.locator('.kb-modal').filter({ hasText: '删除文件夹' });
    await expect(modal).toBeVisible({ timeout: 3_000 });

    // sourceDir has 3 files (a, b, sub/c) + 1 subfolder (sub).
    // Exact text uses "个文件、X 个子文件夹" with a Chinese enumeration comma.
    await expect(modal.locator('.kb-modal-body')).toContainText(/3 个文件/);
    await expect(modal.locator('.kb-modal-body')).toContainText(/1 个子文件夹/);

    // Cancel — don't actually delete.
    await modal.locator('.kb-btn-ghost').first().click();
    await expect(modal).toBeHidden({ timeout: 3_000 });
  });

  test('delete-folder dialog says "空文件夹" for empty directory', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: 'emptyDir' }),
    ).toBeVisible({ timeout: 10_000 });

    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'emptyDir' });
    await label.click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3_000 });
    await page.locator('.ctx-menu-item').filter({ hasText: '删除文件夹' }).click();

    const modal = page.locator('.kb-modal').filter({ hasText: '删除文件夹' });
    await expect(modal).toBeVisible({ timeout: 3_000 });
    await expect(modal.locator('.kb-modal-body')).toContainText(/空文件夹/);

    // Cancel to keep the empty folder on disk for potential re-runs.
    await modal.locator('.kb-btn-ghost').first().click();
    await expect(modal).toBeHidden({ timeout: 3_000 });
  });
});
