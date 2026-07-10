import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P0
 *
 * Large-file viewer: .json files render in a CodeMirror viewer instead of
 * doocs/md, the full content is preserved, the status bar shows size/char
 * statistics, and the UI remains responsive afterwards.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB large-file CodeMirror viewer', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-large-file');

    // Build a ~400 KB JSON file with 4000 entries so the CM path is exercised.
    const entries: Record<string, { name: string; value: number }> = {};
    for (let i = 0; i < 4000; i++) {
      entries[`entity-${i}`] = { name: `Entity ${i}`, value: i };
    }
    fs.writeFileSync(path.join(vault.path, 'big.json'), JSON.stringify(entries, null, 2));
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('renders large .json in CodeMirror with stats and keeps UI responsive', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'big.json' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });
    await fileNode.click();

    const viewer = page.locator('[data-testid="kb-codemirror-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 8_000 });

    // Scroll to the bottom so the last entry is rendered in the virtualized CM surface.
    await page.locator('[data-testid="kb-btn-bottom"]').click();
    // Full content is rendered, not truncated.
    await expect(viewer).toContainText('entity-3999');

    // Status bar shows chars + file size (no expensive word count on CM path).
    const statusBar = page.locator('[data-testid="kb-status-bar"]');
    await expect(statusBar).toContainText('字符');
    await expect(statusBar).toContainText('KB');

    // UI remains responsive: navigating away should immediately leave KB view.
    await clickNav(page, 'home');
    await expect(page.locator('.kb-shell')).toHaveCount(0, { timeout: 5_000 });
  });
});
