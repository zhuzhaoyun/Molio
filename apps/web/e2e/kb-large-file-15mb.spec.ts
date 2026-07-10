import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P0
 *
 * Regression: 15MB text used to freeze the main thread (<pre> whole-file
 * layout). Now CodeMirror virtualizes; the viewer mounts fast and the UI
 * stays responsive.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB 15MB text', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-15mb');
    const line = '凡人修仙传测试行 '.repeat(20) + '\n';
    // Target ~15 MiB; compute repeats from the actual byte length.
    const targetBytes = 15 * 1024 * 1024;
    const bytesPerLine = Buffer.byteLength(line);
    const repeatCount = Math.ceil(targetBytes / bytesPerLine);
    const buf = Buffer.from(line.repeat(repeatCount));
    fs.writeFileSync(path.join(vault.path, 'big.txt'), buf);
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('mounts within 5s and stays responsive', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'big.txt' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });
    await fileNode.click();

    const viewer = page.locator('[data-testid="kb-codemirror-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 5_000 });

    // Nav away is immediate (no main-thread block).
    const t0 = Date.now();
    await clickNav(page, 'home');
    await expect(page.locator('.kb-shell')).toHaveCount(0, { timeout: 3_000 });
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
