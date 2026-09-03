import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * 文件级问答面板（KB 多会话重构后）：
 * - 💬问答 (`kb-btn-ask`) 打开 `kb-chat-panel`，QA 会话空态 + composer @当前文档 badge
 * - 关闭按钮 (`kb-chat-close`) 收起面板
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('File chat panel', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-file-chat-panel');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('toolbar button opens file chat panel', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 💬问答 (document-scoped) opens the multi-session panel.
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();

    // Close button collapses the panel.
    await page.locator('[data-testid="kb-chat-close"]').click();
    await expect(panel).toBeHidden();
  });

  test('empty state shows composer with current file pre-@-mentioned', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await page.locator('[data-testid="kb-btn-ask"]').click();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await expect(panel).toBeVisible();

    // Empty state should be visible before any messages.
    await expect(panel.locator('.file-chat-empty')).toBeVisible();

    // Composer input should be ready.
    const input = panel.locator('[data-testid="composer-input"]');
    await expect(input).toBeVisible();

    // The current file should be pre-filled as an inline @ ref in the composer.
    await expect(input).toHaveValue(/^@doc\.md/);
  });
});
