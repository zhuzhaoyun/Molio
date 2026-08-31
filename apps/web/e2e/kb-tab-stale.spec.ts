import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * Stale tab cleanup (#4) + same-name disambiguation (#5).
 */

let vault: TempVault;

const openTab = async (page: import('@playwright/test').Page, name: string) => {
  // Exact-name match — hasText:name is a substring check that collides when the
  // vault also has e.g. alpha.md (contains "a.md") and sub1/a.md.
  await page.locator('.kb-tree-item').filter({ has: page.getByText(name, { exact: true }) }).click();
};
const expandFolder = async (page: import('@playwright/test').Page, name: string) => {
  await page.locator('.kb-tree-group-label').filter({ hasText: name }).click();
};
const ctxRename = async (page: import('@playwright/test').Page, name: string, newName: string) => {
  await page.locator('.kb-tree-item').filter({ hasText: name }).click({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '重命名' }).click();
  const input = page.locator('.kb-tree-rename-input');
  await expect(input).toBeVisible({ timeout: 3_000 });
  await input.fill(newName);
  await input.press('Enter');
};

test.describe('KB stale tab cleanup (proactive)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-stale');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.mkdirSync(path.join(vault.path, 'sub1'));
    fs.writeFileSync(path.join(vault.path, 'sub1/a.md'), '# A\n');
    fs.mkdirSync(path.join(vault.path, 'sub2'));
    fs.writeFileSync(path.join(vault.path, 'sub2/b.md'), '# B\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('renaming an open tab file updates the tab, keeps active', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' })).toBeVisible({ timeout: 10_000 });
    await openTab(page, 'alpha.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await ctxRename(page, 'alpha.md', 'alpha-renamed.md');
    // tab still 1, title updated, active
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha-renamed.md');
    // tree shows new name
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha-renamed.md' })).toBeVisible({ timeout: 5_000 });
  });

  test('deleting an open tab file closes the tab', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openTab(page, 'alpha-renamed.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'alpha-renamed.md' }).click({ button: 'right' });
    await page.locator('.ctx-menu-item', { hasText: '删除' }).click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '删除' }).click();
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.kb-wtab')).toHaveCount(0, { timeout: 5_000 });
  });

  test('deleting a folder closes all tabs under it, leaves others', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expandFolder(page, 'sub1');
    await openTab(page, 'a.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expandFolder(page, 'sub2');
    await page.locator('[data-testid="kb-tab-add"]').click();
    await openTab(page, 'b.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });

    // delete sub1 folder
    await page.locator('.kb-tree-group-label').filter({ hasText: 'sub1' }).click({ button: 'right' });
    await page.locator('.ctx-menu-item', { hasText: '删除文件夹' }).click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '删除' }).click();
    await expect(overlay).not.toBeVisible();
    // sub1/a.md tab gone; sub2/b.md stays
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('b.md');
  });
});

test.describe('KB stale tab cleanup (reactive)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-reactive');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'real.md'), '# Real\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('a tab whose path no longer exists in the tree gets cleaned on load', async ({ page }) => {
    // seed a stale tab pointing at a non-existent path, but with the correct vaultId
    await page.addInitScript((vaultId) => {
      localStorage.setItem(`molio.kb.tabs.${vaultId}`, JSON.stringify([
        { id: 'file:ghost.md', type: 'file', title: 'ghost.md', vaultId },
        { id: 'file:real.md', type: 'file', title: 'real.md', vaultId },
      ]));
      localStorage.setItem(`molio.kb.activeTabId.${vaultId}`, 'file:ghost.md');
    }, vault.id);

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'real.md' })).toBeVisible({ timeout: 10_000 });
    // ghost.md doesn't exist in tree → its tab cleaned; real.md stays
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toContainText('real.md');
  });

  test('tabs belonging to another vault are not cleaned when this vault loads', async ({ page }) => {
    // seed a tab with a foreign vaultId
    await page.addInitScript((vaultId) => {
      localStorage.setItem(`molio.kb.tabs.${vaultId}`, JSON.stringify([
        { id: 'file:other-vault-file.md', type: 'file', title: 'other-vault-file.md', vaultId: 'vault-foreign' },
        { id: 'file:real.md', type: 'file', title: 'real.md', vaultId },
      ]));
      localStorage.setItem(`molio.kb.activeTabId.${vaultId}`, 'file:real.md');
    }, vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'real.md' })).toBeVisible({ timeout: 10_000 });
    // foreign-vault tab NOT cleaned (still 2 tabs)
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
  });

  test('active tab belonging to another vault is not restored (no cross-vault 404)', async ({ page }) => {
    // Reproduces the "切换时报错" bug: the persisted active tab points at a file
    // in a *foreign* vault (e.g. `wiki/entities/墨大夫.md` open in vault A).
    // On loading vault B, restoring that tab would call readFile on a path that
    // doesn't exist here → a 404 GET + a "file not found" error UI. The fix
    // skips restoration when the active tab's vaultId ≠ current vault, leaving
    // selectedFile null and showing the empty state instead.
    await page.addInitScript((vaultId) => {
      localStorage.setItem(`molio.kb.tabs.${vaultId}`, JSON.stringify([
        { id: 'file:wiki/entities/墨大夫.md', type: 'file', title: '墨大夫.md', vaultId: 'vault-foreign' },
        { id: 'file:real.md', type: 'file', title: 'real.md', vaultId },
      ]));
      localStorage.setItem(`molio.kb.activeTabId.${vaultId}`, 'file:wiki/entities/墨大夫.md');
    }, vault.id);

    const foreignRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('墨大夫')) foreignRequests.push(req.url());
    });

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'real.md' })).toBeVisible({ timeout: 10_000 });

    // No request for the foreign-vault file should have been issued.
    expect(foreignRequests).toEqual([]);
    // No "file not found" error UI — empty state is shown instead.
    await expect(page.locator('.kb-load-error')).toHaveCount(0);
    await expect(page.locator('.kb-empty-state')).toBeVisible();
  });
});

test.describe('KB legacy global tab keys migration (multi-window P2)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-legacy-migrate');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('legacy molio.kb.tabs are migrated into the per-vault key once', async ({ page }) => {
    // Seed ONLY the pre-multi-window global keys (the previous release's format) —
    // no per-vault key, so the migration must run on load.
    await page.addInitScript((vaultId) => {
      localStorage.setItem('molio.kb.tabs', JSON.stringify([
        { id: 'file:alpha.md', type: 'file', title: 'alpha.md' },
        { id: 'file:beta.md', type: 'file', title: 'beta.md' },
      ]));
      localStorage.setItem('molio.kb.activeTabId', 'file:alpha.md');
      // Ensure a fresh context for this vault (no leftover per-vault key).
      localStorage.removeItem(`molio.kb.tabs.${vaultId}`);
      localStorage.removeItem(`molio.kb.activeTabId.${vaultId}`);
    }, vault.id);

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' })).toBeVisible({ timeout: 10_000 });

    // Legacy tabs appear in the tab bar (migrated into this vault's store).
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab').filter({ hasText: 'alpha.md' })).toBeVisible();
    await expect(page.locator('.kb-wtab').filter({ hasText: 'beta.md' })).toBeVisible();

    // Legacy global keys are gone (migration ran once, keys cleaned up).
    await expect.poll(() => page.evaluate(() => localStorage.getItem('molio.kb.tabs'))).toBeNull();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('molio.kb.activeTabId'))).toBeNull();

    // Per-vault key is populated with the migrated tabs + active tab.
    const perVaultTabs = await page.evaluate((vid) => localStorage.getItem(`molio.kb.tabs.${vid}`), vault.id);
    expect(perVaultTabs).not.toBeNull();
    const parsed = JSON.parse(perVaultTabs!);
    expect(parsed.map((t: { id: string }) => t.id)).toEqual(['file:alpha.md', 'file:beta.md']);
    await expect.poll(() =>
      page.evaluate((vid) => localStorage.getItem(`molio.kb.activeTabId.${vid}`), vault.id),
    ).toBe('file:alpha.md');
  });
});

test.describe('KB same-name tab disambiguation (#5)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-samename');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.mkdirSync(path.join(vault.path, 'notes'));
    fs.mkdirSync(path.join(vault.path, 'drafts'));
    fs.writeFileSync(path.join(vault.path, 'notes/index.md'), '# Notes\n');
    fs.writeFileSync(path.join(vault.path, 'drafts/index.md'), '# Drafts\n');
    fs.writeFileSync(path.join(vault.path, 'readme.md'), '# Readme\n');
    fs.mkdirSync(path.join(vault.path, 'x/foo'), { recursive: true });
    fs.mkdirSync(path.join(vault.path, 'y/foo'), { recursive: true });
    fs.writeFileSync(path.join(vault.path, 'x/foo/index.md'), '# X\n');
    fs.writeFileSync(path.join(vault.path, 'y/foo/index.md'), '# Y\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('two same-name files show parent-dir prefix; unique file stays bare', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expandFolder(page, 'notes');
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).first().click();
    await expandFolder(page, 'drafts');
    await page.locator('[data-testid="kb-tab-add"]').click();
    await page.locator('.kb-tree-group').filter({ hasText: 'drafts' }).locator('.kb-tree-item').filter({ hasText: 'index.md' }).click();
    await page.locator('[data-testid="kb-tab-add"]').click();
    await page.locator('.kb-tree-item').filter({ hasText: 'readme.md' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(3, { timeout: 5_000 });

    const titles = await page.locator('.kb-wtab .kb-wtab-title').allTextContents();
    expect(titles).toContain('notes/index.md');
    expect(titles).toContain('drafts/index.md');
    expect(titles).toContain('readme.md');
  });

  test('tab tooltip shows the full relative path', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('.kb-tree-item').filter({ hasText: 'readme.md' }).click();
    await expect(page.locator('.kb-wtab.is-active')).toHaveAttribute('title', 'readme.md');
    await expandFolder(page, 'notes');
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).first().click();
    await expect(page.locator('.kb-wtab.is-active')).toHaveAttribute('title', 'notes/index.md');
  });

  test('deeper same-parent-dir collision falls back to full path', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // two files both at <dir>/foo/index.md → parent name "foo" collides → full path
    await expandFolder(page, 'x');
    await page.locator('.kb-tree-group-label').filter({ hasText: 'foo' }).first().click();
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).first().click();
    await page.locator('[data-testid="kb-tab-add"]').click();
    await expandFolder(page, 'y');
    await page.locator('.kb-tree-group-label').filter({ hasText: 'foo' }).nth(1).click();
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).nth(1).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    const titles = await page.locator('.kb-wtab .kb-wtab-title').allTextContents();
    expect(titles).toContain('x/foo/index.md');
    expect(titles).toContain('y/foo/index.md');
  });
});
