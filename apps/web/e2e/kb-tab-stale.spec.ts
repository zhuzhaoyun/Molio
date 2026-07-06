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
  await page.locator('.kb-tree-item').filter({ hasText: name }).click();
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
    await expandFolder(page, 'sub2');
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
      localStorage.setItem('molio.kb.tabs', JSON.stringify([
        { id: 'file:ghost.md', type: 'file', title: 'ghost.md', vaultId },
        { id: 'file:real.md', type: 'file', title: 'real.md', vaultId },
      ]));
      localStorage.setItem('molio.kb.activeTabId', 'file:ghost.md');
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
      localStorage.setItem('molio.kb.tabs', JSON.stringify([
        { id: 'file:other-vault-file.md', type: 'file', title: 'other-vault-file.md', vaultId: 'vault-foreign' },
        { id: 'file:real.md', type: 'file', title: 'real.md', vaultId },
      ]));
      localStorage.setItem('molio.kb.activeTabId', 'file:real.md');
    }, vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'real.md' })).toBeVisible({ timeout: 10_000 });
    // foreign-vault tab NOT cleaned (still 2 tabs)
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
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
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).first().click();
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
    await expandFolder(page, 'y');
    await page.locator('.kb-tree-group-label').filter({ hasText: 'foo' }).nth(1).click();
    await page.locator('.kb-tree-item:visible').filter({ hasText: 'index.md' }).nth(1).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    const titles = await page.locator('.kb-wtab .kb-wtab-title').allTextContents();
    expect(titles).toContain('x/foo/index.md');
    expect(titles).toContain('y/foo/index.md');
  });
});
