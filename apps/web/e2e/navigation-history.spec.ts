import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area navigation
 * @priority P1
 *
 * Tab-scoped view history. The forward/back buttons walk the order of files the
 * user has viewed in the KB tab workspace. With the #241 tab model (click a file
 * recycles the current tab), back/forward re-open the target file via
 * handleSelectFile — activating an existing tab or recycling the current one —
 * so navigation never grows the tab count.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Navigation history (tabs)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-nav-history');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
    fs.writeFileSync(path.join(vault.path, 'gamma.md'), '# Gamma\n');
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('back/forward buttons render in the KB title bar', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="nav-back"]')).toBeVisible();
    await expect(page.locator('[data-testid="nav-forward"]')).toBeVisible();
  });

  test('both buttons are disabled when no file is open yet', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="nav-back"]')).toBeDisabled();
    await expect(page.locator('[data-testid="nav-forward"]')).toBeDisabled();
  });

  test('viewing files then back/forward walks the sequence (recycle, no tab growth)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    const gamma = page.locator('.kb-tree-item').filter({ hasText: 'gamma.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await expect(beta).toBeVisible({ timeout: 10_000 });
    await expect(gamma).toBeVisible({ timeout: 10_000 });

    const activeTitle = () => page.locator('.kb-wtab.is-active');
    const tabCount = () => page.locator('.kb-wtab');

    // View alpha → beta → gamma. The #241 model recycles the current tab, so
    // there is always just ONE tab whose file changes.
    await alpha.click();
    await expect(activeTitle()).toContainText('alpha.md', { timeout: 5_000 });
    await beta.click();
    await expect(tabCount()).toHaveCount(1, { timeout: 5_000 });
    await expect(activeTitle()).toContainText('beta.md');
    await gamma.click();
    await expect(tabCount()).toHaveCount(1);
    await expect(activeTitle()).toContainText('gamma.md');

    // Back ×2 → gamma → beta → alpha (recycling the same tab each time).
    await page.locator('[data-testid="nav-back"]').click();
    await expect(activeTitle()).toContainText('beta.md');
    await expect(tabCount()).toHaveCount(1); // no new tab spawned
    await page.locator('[data-testid="nav-back"]').click();
    await expect(activeTitle()).toContainText('alpha.md');
    await expect(tabCount()).toHaveCount(1);

    // Forward ×2 → beta → gamma.
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(activeTitle()).toContainText('beta.md');
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(activeTitle()).toContainText('gamma.md');
  });
});
