import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 *
 * 文件级问答面板（KB 多会话重构后）：
 * - 💬问答 (`kb-btn-ask`) 打开 `kb-chat-panel`，QA 会话空态 + composer @当前文档 badge
 * - 关闭按钮 (`kb-chat-close`) 收起面板
 * - 面板助手消息具备完整消息级工具条（重生成/继续/删除）
 * Prerequisites: `pnpm dev`.
 */
let vault: TempVault;

test.describe('File chat panel', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-file-chat-panel');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

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

  test('面板里的助手消息带完整工具条（重新生成/继续/删除）', async ({ page }) => {
    await mockChatRun(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await panel.locator('[data-testid="composer-input"]').fill('工具条测试');
    await page.locator('[data-testid="composer-send"]').click();

    const lastAssistant = panel.locator('[data-testid="assistant-message"]').last();
    await expect(lastAssistant).toBeVisible();
    // Wait for the reply to settle (toolbar only renders once streaming ends).
    await expect(lastAssistant).toContainText('Hello,', { timeout: 10_000 });
    await lastAssistant.hover();
    await expect(lastAssistant.locator('[data-testid="msg-regenerate-btn"]')).toBeVisible();
    await expect(lastAssistant.locator('[data-testid="msg-continue-btn"]')).toBeVisible();
  });
});
