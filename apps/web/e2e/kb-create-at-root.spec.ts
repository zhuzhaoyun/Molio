/**
 * @area kb
 * @priority P1
 *
 * Toolbar "+" and blank-area right-click both create at the vault ROOT —
 * regardless of which file is currently selected (fix for "新建文件夹在根目录
 * 创建失败").
 *
 * Regression: before the fix, "+ → 新建文件夹" silently targeted the SELECTED
 * file's parent dir (createParentDir), so with sub/note.md selected the dialog
 * said "在 sub 下新建文件夹" and the folder landed inside sub/ — invisible at
 * root. The blank-area right-click entry did not exist at all.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

const WEB = 'http://localhost:5173';

let vault: TempVault;

test.describe('KB root-level folder creation', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-create-at-root');
    // Remove the seed test.md so the tree only has the structure we build here.
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    // sub/note.md — a file inside a subfolder, used to simulate a selected file
    // whose parent is NOT the vault root.
    fs.mkdirSync(path.join(vault.path, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'sub', 'note.md'), '# note\n');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('toolbar "+ → 新建文件夹" creates at root even when a subfolder file is selected', async ({ page }) => {
    await page.goto(`${WEB}/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    // Select a file inside a subfolder (the pre-bug trigger state).
    const subLabel = page.locator('.kb-tree-group-label').filter({ hasText: 'sub' });
    const noteFile = page.locator('.kb-tree-item').filter({ hasText: 'note.md' });
    if (!(await noteFile.isVisible().catch(() => false))) {
      await subLabel.click(); // expand sub
    }
    await expect(noteFile).toBeVisible({ timeout: 5_000 });
    await noteFile.click();
    await page.waitForTimeout(300);

    // Open "+ → 新建文件夹".
    await page.locator('[data-testid="kb-btn-create"]').click();
    await expect(page.locator('[data-testid="kb-create-dropdown"]')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-create-folder"]').click();
    const dialog = page.locator('.kb-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The dialog must target the ROOT — no "在 sub 下新建文件夹" title.
    const title = (await dialog.locator('.kb-modal-header h2').textContent())?.trim();
    expect(title).toBe('新建文件夹');

    const folderName = `__root_${Date.now() % 100000}__`;
    await dialog.locator('input').fill(folderName);
    await dialog.locator('.kb-btn-primary').click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Created at the vault root (visible as a top-level tree group).
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: folderName }),
    ).toBeVisible({ timeout: 5_000 });

    // And on disk: at the vault root, NOT inside sub/.
    expect(fs.existsSync(path.join(vault.path, folderName))).toBe(true);
    expect(fs.existsSync(path.join(vault.path, 'sub', folderName))).toBe(false);
  });

  test('right-click tree blank area → "新建文件夹" creates at root', async ({ page }) => {
    await page.goto(`${WEB}/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    // Right-click on the tree's blank area (bottom-left of the scroll region,
    // away from any node).
    const box = await page.locator('.kb-tree-scroll').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + 30, box!.y + box!.height - 8, { button: 'right' });

    // Root-level context menu appears.
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-ctx-new-folder-root"]')).toBeVisible();
    await page.locator('[data-testid="kb-ctx-new-folder-root"]').click();

    // Dialog targets the root.
    const dialog = page.locator('.kb-modal');
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    const title = (await dialog.locator('.kb-modal-header h2').textContent())?.trim();
    expect(title).toBe('新建文件夹');

    const folderName = `__blank_${Date.now() % 100000}__`;
    await dialog.locator('input').fill(folderName);
    await dialog.locator('.kb-btn-primary').click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    // Created at the vault root.
    await expect(
      page.locator('.kb-tree-group-label').filter({ hasText: folderName }),
    ).toBeVisible({ timeout: 5_000 });
    expect(fs.existsSync(path.join(vault.path, folderName))).toBe(true);
  });
});
