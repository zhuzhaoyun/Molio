import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P1
 *
 * Large files above the daemon's view-size cap render a too-large card with a
 * force-load button. Clicking force-load re-fetches with ?force=1 and mounts the
 * CodeMirror viewer.
 *
 * Requires daemon started with MOLIO_MAX_VIEW_SIZE=1048576 (1MB).
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB too-large file card', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-too-large');
    fs.writeFileSync(
      path.join(vault.path, 'big.txt'),
      Buffer.alloc(2 * 1024 * 1024, 0x61), // 2 MB > 1 MB cap
    );
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('shows too-large card and force-loads on click', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'big.txt' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });
    await fileNode.click();

    await expect(page.locator('.kb-file-card')).toBeVisible({ timeout: 8_000 });
    await expect(page.locator('.kb-file-card')).toContainText('2.0 MB');

    await page.locator('[data-testid="kb-btn-force"]').click();
    await expect(page.locator('[data-testid="kb-codemirror-viewer"]')).toBeVisible({ timeout: 10_000 });
  });
});
