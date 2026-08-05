/**
 * @area kb-import
 * @priority P1
 *
 * Real mouse-based drag test for FILE move — comparison baseline.
 * Verifies the actual on-disk move happens end-to-end (regression test for
 * the stale-closure bug where `kb.activeVault` was null during the initial
 * vault-auto-select window).
 */
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

let vault: TempVault;

test.describe('KB file drag (real mouse)', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-file-drag-real');
    fs.writeFileSync(path.join(vault.path, 'moveme.md'), '# move me\n');
    fs.mkdirSync(path.join(vault.path, 'folderB'), { recursive: true });
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('drag moveme.md onto folderB moves it on disk', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator('.kb-tree-item').filter({ hasText: 'moveme.md' }),
    ).toBeVisible({ timeout: 10_000 });

    const logs: string[] = [];
    page.on('console', (msg) => logs.push(`[${msg.type()}] ${msg.text()}`));

    const src = page.locator('.kb-tree-item').filter({ hasText: 'moveme.md' });
    const dest = page.locator('.kb-tree-group-label').filter({ hasText: 'folderB' });

    const srcBox = await src.boundingBox();
    const destBox = await dest.boundingBox();
    expect(srcBox && destBox).toBeTruthy();

    await page.mouse.move(srcBox!.x + srcBox!.width / 2, srcBox!.y + srcBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(srcBox!.x + srcBox!.width / 2 + 5, srcBox!.y + 5, { steps: 3 });
    await page.mouse.move(destBox!.x + destBox!.width / 2, destBox!.y + destBox!.height / 2, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(2000);
    console.log('CAPTURED LOGS:\n' + logs.join('\n'));

    const moved = fs.existsSync(path.join(vault.path, 'folderB', 'moveme.md'));
    const oldGone = !fs.existsSync(path.join(vault.path, 'moveme.md'));
    expect(moved).toBe(true);
    expect(oldGone).toBe(true);
  });
});
