/**
 * @area kb
 * @priority P0
 *
 * Regression test for the test.json freeze: a large text file (e.g. a 4 MB
 * `.json`) used to be fed straight into the doocs/md pipeline (`marked` +
 * `DOMPurify.sanitize` on a multi-MB string), which blocked the main thread
 * and froze the UI. Because the KB tab store re-opens the last-active file on
 * restart, the app stayed bricked until localStorage was wiped.
 *
 * Now files beyond LARGE_TEXT_THRESHOLD (256 KB) render as a full,
 * non-wrapping monospace `<pre>` (no truncation) and skip `countWords`,
 * so the UI stays responsive.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

let vault: TempVault;

test.describe('KB large-text file', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-large-file');
    // A >256 KB JSON file — big enough to trip LARGE_TEXT_THRESHOLD but small
    // enough to keep the test fast. Each entry ~100 bytes; 4000 entries ≈ 400 KB.
    const entries = Array.from({ length: 4000 }, (_, i) => ({
      id: i,
      name: `entity-${i}`,
      description: '五专业59本建筑规范实体特征上下位跨规范引用统一知识库占位文本',
    }));
    fs.writeFileSync(path.join(vault.path, 'big.json'), JSON.stringify(entries, null, 2));
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('renders lightweight preview without freezing the UI', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    const fileNode = page.locator('.kb-tree-item').filter({ hasText: 'big.json' });
    await fileNode.waitFor({ state: 'visible', timeout: 10_000 });

    // The proof that we did NOT freeze: the preview appears quickly. If the
    // old code path ran, marked + DOMPurify on ~400 KB would block for many
    // seconds and this assertion would time out.
    await fileNode.click();
    const preview = page.locator('[data-testid="kb-large-text-preview"]');
    await expect(preview).toBeVisible({ timeout: 8_000 });

    // The <pre> must actually contain file content, not a blank.
    await expect(preview.locator('.kb-large-text-pre')).not.toBeEmpty();
    // The full file is shown (no truncation): the last generated entry is
    // present. If a cap were reintroduced, this would fail.
    await expect(preview.locator('.kb-large-text-pre')).toContainText('entity-3999');
    // Notice mentions the file name and that rendering was skipped.
    await expect(preview.locator('.kb-large-text-notice')).toContainText('big.json');

    // Status bar shows size (not the expensive word count) for large files.
    const statusBar = page.locator('[data-testid="kb-status-bar"]');
    await expect(statusBar).toBeVisible({ timeout: 5_000 });
    await expect(statusBar).toContainText('大小');

    // UI is still responsive — clicking another nav target works immediately.
    await clickNav(page, 'home');
    await expect(page.locator('.kb-shell')).toHaveCount(0, { timeout: 5_000 });
  });
});
