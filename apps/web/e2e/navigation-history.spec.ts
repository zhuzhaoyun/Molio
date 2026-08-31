import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area navigation
 * @priority P1
 *
 * Tab-scoped view history: the forward/back buttons walk the order of files the
 * user has viewed within the KB tab workspace, restricted to currently-open tabs.
 * Closing a file prunes it from history (closed-loop within the tab workspace).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('Navigation history (tabs)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-nav-history');
    fs.writeFileSync(path.join(vault.path, 'alpha.md'), '# Alpha\n');
    fs.writeFileSync(path.join(vault.path, 'beta.md'), '# Beta\n');
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

  test('opening two files then back/forward walks the file history', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await expect(beta).toBeVisible({ timeout: 10_000 });

    // Open two files → they become the history stack.
    await alpha.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    await beta.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');

    // Back → activate alpha.md (its tab, not a new one).
    await page.locator('[data-testid="nav-back"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('alpha.md');
    await expect(page.locator('.kb-wtab')).toHaveCount(2); // no duplicate tab

    // Forward → beta.md again.
    await page.locator('[data-testid="nav-forward"]').click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('beta.md');
  });

  test('closing a file prunes it from history (no back target)', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

    const alpha = page.locator('.kb-tree-item').filter({ hasText: 'alpha.md' });
    await expect(alpha).toBeVisible({ timeout: 10_000 });
    await alpha.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    // Only alpha open → single history entry → back disabled.
    await expect(page.locator('[data-testid="nav-back"]')).toBeDisabled();

    // Open beta, close it → only alpha remains → still no back target.
    const beta = page.locator('.kb-tree-item').filter({ hasText: 'beta.md' });
    await beta.click();
    await expect(page.locator('.kb-wtab')).toHaveCount(2, { timeout: 5_000 });
    await page.locator('.kb-wtab.is-active .kb-wtab-close').click(); // close beta
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });

    await expect(page.locator('[data-testid="nav-back"]')).toBeDisabled();
    await expect(page.locator('[data-testid="nav-forward"]')).toBeDisabled();
  });
});
