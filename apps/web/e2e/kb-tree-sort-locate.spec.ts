import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Left-tree-toolbar Step 2: 文件排序 (sort) + 文件定位 (locate/reveal).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB tree sort + locate', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-tree-sort-locate');
    // createTempVault seeds a test.md — drop it so the root only has our files.
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    // Three root-level files with distinct mtimes / sizes.
    fs.writeFileSync(path.join(vault.path, 'old.md'), '# Old\n');
    fs.writeFileSync(path.join(vault.path, 'mid.md'), '# Mid\nmid body\n');
    fs.writeFileSync(path.join(vault.path, 'new.md'), '# New\n');
    // A deeply nested file for the locate test.
    fs.mkdirSync(path.join(vault.path, 'dirA', 'subA'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'dirA', 'subA', 'deep.md'), '# Deep\n');

    // fs.utimesSync takes seconds or Date — passing Date.now() (ms) as a number
    // overflows into an Int64-max sentinel that collapses every file to the same
    // mtime, so use Date instances.
    const now = Date.now();
    const day = 86_400_000;
    fs.utimesSync(path.join(vault.path, 'old.md'), new Date(now - 10 * day), new Date(now - 10 * day));
    fs.utimesSync(path.join(vault.path, 'mid.md'), new Date(now - 5 * day), new Date(now - 5 * day));
    fs.utimesSync(path.join(vault.path, 'new.md'), new Date(now), new Date(now));
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('sort by modified time lists newest first; back to name restores alpha order', async ({ page }) => {
    // Open mid.md so a file is selected (no bearing on sort, just a stable landing).
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=mid.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Default sort = by name → mid / new / old (alphabetical)
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'mid.md' })).toBeVisible({ timeout: 10_000 });

    // Only VISIBLE root-level items — collapsed descendants stay in the DOM
    // (display:none) and would otherwise pollute the list.
    const names = async () =>
      (await page.locator('.kb-tree-item .kb-tree-name')
        .filter({ visible: true })
        .allTextContents())
        .filter((n) => n.endsWith('.md'));

    expect(await names()).toEqual(['mid.md', 'new.md', 'old.md']);

    // Open sort menu, switch to "按修改时间"
    await page.locator('[data-testid="kb-btn-sort"]').click();
    await expect(page.locator('[data-testid="kb-sort-dropdown"]')).toBeVisible();
    await page.locator('[data-testid="kb-sort-modified"]').click();

    // Newest first → new / mid / old
    await expect.poll(async () => await names()).toEqual(['new.md', 'mid.md', 'old.md']);
    // Active option is marked checked
    await page.locator('[data-testid="kb-btn-sort"]').click();
    await expect(page.locator('[data-testid="kb-sort-dropdown"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-sort-modified"]')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // Switch to "按大小" → mid (9 bytes) largest, then new/old (tie → keep stable)
    await page.locator('[data-testid="kb-btn-sort"]').click();
    await page.locator('[data-testid="kb-sort-size"]').click();
    await expect.poll(async () => (await names())[0]).toBe('mid.md');

    // Back to name
    await page.locator('[data-testid="kb-btn-sort"]').click();
    await page.locator('[data-testid="kb-sort-name"]').click();
    await expect.poll(async () => await names()).toEqual(['mid.md', 'new.md', 'old.md']);
  });

  test('locate expands ancestors and reveals the active file', async ({ page }) => {
    // Open the deep file via URL. Ancestors (dirA, dirA/subA) start collapsed,
    // so deep.md is NOT rendered in the tree even though it is the active file.
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=dirA/subA/deep.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // Wait for the tree root to load
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' })).toBeVisible({ timeout: 10_000 });

    // deep.md hidden while dirA/subA are collapsed
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'deep.md' })).not.toBeVisible();

    // Locate button is enabled (a file is active) and reveals the file
    const locate = page.locator('[data-testid="kb-btn-locate"]');
    await expect(locate).not.toBeDisabled();
    await locate.click();

    // Ancestors expanded → deep.md now rendered and visible
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'deep.md' })).toBeVisible();
  });

  test('locate disabled when no file is open', async ({ page }) => {
    // No ?file= param → no file selected → locate disabled
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="kb-btn-locate"]')).toBeDisabled();
  });

  // Regression: extension-less file links (assistant markdown links and
  // molio:// URLs routinely omit ".md"). The daemon's readFile tolerates the
  // missing extension so the file opens, but the frontend must normalize the
  // path against the tree so the tab title carries the format and the locate
  // button can match the active tree row. Mirrors the canonical-path case above.
  test('extension-less link opens with formatted title and is locatable', async ({ page }) => {
    // Same file as the canonical test above, but the URL omits ".md".
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=dirA/subA/deep`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' })).toBeVisible({ timeout: 10_000 });

    // Tab title must carry the on-disk extension, not the raw link text.
    await expect(page.locator('.kb-wtab-title').filter({ hasText: 'deep.md' })).toBeVisible({ timeout: 5_000 });

    // deep.md hidden while ancestors are collapsed
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'deep.md' })).not.toBeVisible();

    const locate = page.locator('[data-testid="kb-btn-locate"]');
    await expect(locate).not.toBeDisabled();
    await locate.click();

    // Ancestors expanded → deep.md visible AND marked active (path matched).
    const deepItem = page.locator('.kb-tree-item').filter({ hasText: 'deep.md' });
    await expect(deepItem).toBeVisible();
    await expect(deepItem).toHaveClass(/is-active/);
  });

  // Regression: bare page-name links (wiki-style "[[deep]]") resolve to the
  // file anywhere in the tree, not just at the root.
  test('bare page-name link resolves to nested file and is locatable', async ({ page }) => {
    // "deep" has no directory component — resolver must walk the tree.
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=deep`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'dirA' })).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.kb-wtab-title').filter({ hasText: 'deep.md' })).toBeVisible({ timeout: 5_000 });

    const locate = page.locator('[data-testid="kb-btn-locate"]');
    await expect(locate).not.toBeDisabled();
    await locate.click();

    const deepItem = page.locator('.kb-tree-item').filter({ hasText: 'deep.md' });
    await expect(deepItem).toBeVisible();
    await expect(deepItem).toHaveClass(/is-active/);
  });

  // Regression: wiki-links routinely drop the "wiki/" prefix — e.g.
  // [[entities/宇树科技]] points at wiki/entities/宇树科技.md. The link carries
  // a directory component (so the bare-name walker doesn't fire) AND omits both
  // the prefix and ".md". The resolver must try the wiki/ prefix, mirroring the
  // daemon's resolveWithFallbacks.
  test('wiki-link missing the wiki/ prefix resolves to the nested file', async ({ page }) => {
    fs.mkdirSync(path.join(vault.path, 'wiki', 'entities'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'wiki', 'entities', '宇树科技.md'), '# 宇树\n');

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=entities/宇树科技`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'wiki' })).toBeVisible({ timeout: 10_000 });

    // Tab title carries the on-disk name (with .md), not the raw link text.
    await expect(page.locator('.kb-wtab-title').filter({ hasText: '宇树科技.md' })).toBeVisible({ timeout: 5_000 });

    const locate = page.locator('[data-testid="kb-btn-locate"]');
    await expect(locate).not.toBeDisabled();
    await locate.click();

    const item = page.locator('.kb-tree-item').filter({ hasText: '宇树科技.md' });
    await expect(item).toBeVisible();
    await expect(item).toHaveClass(/is-active/);
  });

  // Regression: non-md file. A link like [[entities/季度报告]] (dir + no ext)
  // must resolve to 季度报告.pdf via stem matching, not just .md. Stem MUST
  // differ from the 宇树科技.md test above, or .md-priority would pick the .md.
  test('non-md file resolves via stem match when link omits extension', async ({ page }) => {
    fs.mkdirSync(path.join(vault.path, 'wiki', 'entities'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'wiki', 'entities', '季度报告.pdf'), '%PDF-1.4\n');

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=entities/季度报告`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'wiki' })).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('.kb-wtab-title').filter({ hasText: '季度报告.pdf' })).toBeVisible({ timeout: 5_000 });

    const locate = page.locator('[data-testid="kb-btn-locate"]');
    await expect(locate).not.toBeDisabled();
    await locate.click();

    const item = page.locator('.kb-tree-item').filter({ hasText: '季度报告.pdf' });
    await expect(item).toBeVisible();
    await expect(item).toHaveClass(/is-active/);
  });

});
