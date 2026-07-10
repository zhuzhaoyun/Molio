import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P0
 *
 * GBK-encoded large text files should be decoded correctly (via gb18030)
 * without replacement characters, and the status bar should report the encoding.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */

let vault: TempVault;

test.describe('KB GBK large text', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-gbk');
    // 「你好世界」in GBK bytes, repeated to ~400KB so it's non-trivial but fast.
    const unit = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]); // 你好世界
    const buf = Buffer.concat(Array.from({ length: 50000 }, () => unit));
    fs.writeFileSync(path.join(vault.path, 'novel.txt'), buf);
  });

  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('decodes GBK without U+FFFD and shows encoding', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'novel.txt' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });
    await fileNode.click();

    const viewer = page.locator('[data-testid="kb-codemirror-viewer"]');
    await expect(viewer).toBeVisible({ timeout: 8_000 });
    await expect(viewer).toContainText('你好世界');

    // No replacement characters (U+FFFD).
    const text = await viewer.textContent();
    expect(text).not.toContain('�');

    // Status bar reports encoding.
    await expect(page.locator('[data-testid="kb-status-bar"]')).toContainText(/gb18030|gbk/i);
  });
});
