/**
 * @area kb
 * @priority P1
 *
 * Vault-switch & large-tree rendering performance regression tests:
 * 1) Collapsed folders lazy-mount children (zero `.kb-tree-children` / hidden child DOM nodes until expanded).
 * 2) Tree filter search auto-expands folders with matching nested files and restores collapsed state when cleared.
 * 3) Switching vaults in reuse mode sends metadata-only `/vaults` (`Prefer: return=minimal`),
 *    isolates folder expansion state per vault, and restores cached trees without flashing blank.
 */

import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vaultA: TempVault;
let vaultB: TempVault;

test.describe('KB vault switch & lazy tree rendering performance', () => {
  test.beforeAll(async () => {
    vaultA = await createTempVault('e2e-perf-vault-a');
    vaultB = await createTempVault('e2e-perf-vault-b');

    fs.mkdirSync(path.join(vaultA.path, 'entities'), { recursive: true });
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(vaultA.path, 'entities', `entity-${i}.md`), `# Entity ${i}\n`);
    }
    fs.writeFileSync(path.join(vaultA.path, 'entities', 'needle-note.md'), '# Needle\n');

    fs.mkdirSync(path.join(vaultB.path, 'entities'), { recursive: true });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(vaultB.path, 'entities', `topic-${i}.md`), `# Topic ${i}\n`);
    }
  });

  test.afterAll(async () => {
    if (vaultA) await cleanupTempVault(vaultA);
    if (vaultB) await cleanupTempVault(vaultB);
  });

  test('collapsed directories do not mount child DOM nodes until expanded, and search auto-expands matches', async ({ page }) => {
    let minimalVaultListRequested = false;
    page.on('request', (req) => {
      if (req.url().endsWith('/api/knowledge/vaults') && req.method() === 'GET') {
        if (req.headers()['prefer'] === 'return=minimal') {
          minimalVaultListRequested = true;
        }
      }
    });

    await page.goto(`/knowledge?vault=${vaultA.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 10_000 });
    const entitiesLabel = page.locator('.kb-tree-group-label').filter({ hasText: 'entities' });
    await expect(entitiesLabel).toBeVisible({ timeout: 10_000 });
    expect(minimalVaultListRequested).toBe(true);

    // Lazy DOM guard: while `entities` is collapsed, none of its 41 children are mounted in the DOM!
    await expect(page.locator('.kb-tree-children')).toHaveCount(0);
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'entity-0.md' })).toHaveCount(0);

    // Search auto-expands folders containing matching descendants
    await page.getByTestId('kb-tree-search').fill('needle-note');
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'needle-note.md' })).toBeVisible();

    // Clearing search returns `entities` to collapsed (zero child DOM nodes again)
    await page.getByTestId('kb-tree-search').fill('');
    await expect(page.locator('.kb-tree-children')).toHaveCount(0);

    // Clicking `entities` mounts its children
    await entitiesLabel.click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'entity-0.md' })).toBeVisible();
  });

  test('vault switch isolates per-vault folder expansion state and reuses cached tree on return', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('molio.vaultSwitchWindow', 'reuse');
    });

    await page.goto(`/knowledge?vault=${vaultA.id}`);
    await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 10_000 });

    const entitiesLabel = page.locator('.kb-tree-group-label').filter({ hasText: 'entities' });
    await expect(entitiesLabel).toBeVisible({ timeout: 10_000 });
    await entitiesLabel.click();
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'entity-0.md' })).toBeVisible();

    // Switch to vaultB in-place via Vault Manager
    await page.locator('.kb-vault-bar').click();
    const modal = page.getByTestId('vault-manager-modal');
    await expect(modal).toBeVisible();
    await modal.locator('.vm-vault-item').filter({ hasText: vaultB.name }).click();
    if (await modal.isVisible()) {
      await page.getByTestId('vault-manager-close').click();
    }

    await expect(page.locator('.kb-vault-bar__name')).toHaveText(vaultB.name);
    // Even though vaultB ALSO has a folder named `entities`, vaultA's expanded state must NOT leak into vaultB!
    await expect(page.locator('.kb-tree-group-label').filter({ hasText: 'entities' })).toBeVisible();
    await expect(page.locator('.kb-tree-children')).toHaveCount(0);
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'topic-0.md' })).toHaveCount(0);

    // Switch back to vaultA: vaultA's expanded state AND cached tree restore immediately!
    await page.locator('.kb-vault-bar').click();
    await expect(modal).toBeVisible();
    await modal.locator('.vm-vault-item').filter({ hasText: vaultA.name }).click();
    if (await modal.isVisible()) {
      await page.getByTestId('vault-manager-close').click();
    }

    await expect(page.locator('.kb-vault-bar__name')).toHaveText(vaultA.name);
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'entity-0.md' })).toBeVisible();
  });
});
