/**
 * @area kb
 * @priority P1
 *
 * Folder expand-state visibility in the KB file tree.
 * Regression background: a childless folder (empty, or pruned by the daemon's
 * MAX_DIR_ENTRIES cap) used to render zero visible change on click — the
 * chevron flip alone read as "click did nothing". Folders now keep an
 * `is-open` tint while expanded and childless folders show a ghost row that
 * states why: 「空文件夹」 or 「文件过多，未显示」.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

// Mirror of daemon MAX_DIR_ENTRIES (apps/daemon/src/core/vault-prune.ts).
const MAX_DIR_ENTRIES = 5000;

let vault: TempVault;

test.describe('KB tree folder expand state', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tree-folder-state');
    // A genuinely empty folder
    fs.mkdirSync(path.join(vault.path, 'emptyDir'), { recursive: true });
    // A folder with content, for the normal-expand sanity case
    fs.mkdirSync(path.join(vault.path, 'normalDir'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'normalDir', 'note.md'), '# note\n');
    // A folder over the per-directory cap → daemon prunes it (children: [])
    // and flags it pruned; the tree must say so instead of a silent blank.
    const dumpDir = path.join(vault.path, 'dumpDir');
    fs.mkdirSync(dumpDir, { recursive: true });
    for (let i = 0; i <= MAX_DIR_ENTRIES; i++) {
      fs.writeFileSync(path.join(dumpDir, `f${i}.md`), 'x');
    }
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('empty folder shows 「空文件夹」 ghost row while expanded', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'emptyDir' });
    await expect(label).toBeVisible({ timeout: 10_000 });

    // Collapsed: no ghost row, no open tint
    await expect(page.locator('[data-testid="kb-tree-empty-hint"]')).toHaveCount(0);
    await expect(label).not.toHaveClass(/is-open/);

    // Expand: ghost row explains the childless state, label keeps the open tint
    await label.click();
    const hint = page.locator('[data-testid="kb-tree-empty-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText('空文件夹');
    await expect(label).toHaveClass(/is-open/);

    // Collapse: both disappear again
    await label.click();
    await expect(hint).toHaveCount(0);
    await expect(label).not.toHaveClass(/is-open/);
  });

  test('folder with children expands without a ghost row', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'normalDir' });
    await label.click();
    await expect(label).toHaveClass(/is-open/);
    await expect(page.locator('.kb-tree-name').filter({ hasText: 'note.md' })).toBeVisible();
    await expect(page.locator('[data-testid="kb-tree-empty-hint"]')).toHaveCount(0);
  });

  test('oversized pruned folder shows 「文件过多，未显示」 ghost row', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'dumpDir' });
    await expect(label).toBeVisible({ timeout: 10_000 });

    await label.click();
    const hint = page.locator('[data-testid="kb-tree-pruned-hint"]');
    await expect(hint).toBeVisible({ timeout: 15_000 });
    await expect(hint).toHaveText('文件过多，未显示');
    await expect(label).toHaveClass(/is-open/);
    // Pruned ≠ loaded: none of the 5001 files may appear
    await expect(page.locator('.kb-tree-name').filter({ hasText: /^f\d+\.md$/ }).first()).toHaveCount(0);
  });

  test('search filtering does not surface ghost rows', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 5_000 });

    // Expand emptyDir first, then search for something that empties its
    // children in the filtered view — "no hits" must not read as 「空文件夹」.
    const label = page.locator('.kb-tree-group-label').filter({ hasText: 'emptyDir' });
    await label.click();
    await expect(page.locator('[data-testid="kb-tree-empty-hint"]')).toBeVisible();

    await page.locator('.kb-search-bar input').fill('zzz-no-match');
    await expect(page.locator('[data-testid="kb-tree-empty-hint"]')).toHaveCount(0);

    // Back to no query → ghost row returns
    await page.locator('.kb-search-bar input').fill('');
    await expect(page.locator('[data-testid="kb-tree-empty-hint"]')).toBeVisible();
  });
});
