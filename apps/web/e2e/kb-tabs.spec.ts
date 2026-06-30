import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * KB tab bar: opening a new file from the file tree must open a new tab
 * rather than overwriting the currently active tab.
 *
 * Regression for: previously handleSelectFile replaced the active tab's
 * id/title with the newly clicked file, so the original document's tab was
 * lost. Now each opened file gets its own tab appended to the right.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB tab bar', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tabs');
    // createTempVault seeds test.md — replace with two known files.
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('opening a second file from the tree adds a new tab without losing the first', async ({ page }) => {
    // Select the vault without opening a file (no leftover tabs).
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const alphaItem = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const betaItem = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alphaItem).toBeVisible({ timeout: 10_000 });
    await expect(betaItem).toBeVisible({ timeout: 10_000 });

    // 1. Open alpha.md — one tab, active.
    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');

    // 2. Open beta.md from the tree — must ADD a tab, not overwrite alpha.
    await betaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });

    // Both files remain as their own tabs; beta (clicked last) is active.
    const titles = await page.locator('.kb-wtab .kb-wtab-title').allTextContents();
    expect(titles).toEqual(['alpha.md', 'beta.md']);
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');

    // 3. Click alpha.md again — reuses the existing tab, no third tab created.
    await alphaItem.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');
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

    // Click beta.md → unsaved-changes guard must prompt.
    await betaItem.click();
    const overlay = page.locator('.kb-overlay.show');
    await expect(overlay).toBeVisible({ timeout: 3_000 });

    // Cancel → stay on alpha, edits preserved, still one tab.
    await overlay.locator('button', { hasText: '取消' }).click();
    await expect(overlay).not.toBeVisible();
    await expect(page.locator('.kb-wtab')).toHaveCount(1);
    await expect(textarea).toHaveValue(/UNSAVED EDIT MARKER/);

    // Click beta.md again → confirm discard → switches, new tab added.
    await betaItem.click();
    await expect(overlay).toBeVisible({ timeout: 3_000 });
    await overlay.locator('button', { hasText: '放弃修改并切换' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
  });
});
