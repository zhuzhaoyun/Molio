import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

const TEST_VAULT_ID = 'e2e-op-card-vault';

/**
 * Test coverage for FileOperationCard and DiffView (Phase 1 / Phase 3).
 *
 * Specification:
 * - When AI tools write files, operation cards appear in chat with
 *   [打开文件] [查看本次修改] [💬 讨论这个文件] buttons.
 * - Inline diff with add/del/ctx lines.
 * - Write tools filtered from regular tool-cards to prevent duplicate rendering.
 */

test.describe('File operation cards', () => {
  test.beforeEach(async ({ page }) => {
    // Mock vault list so vaultStore has an active vault for Open/Discuss buttons.
    await page.route('**/api/knowledge/vaults', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: {
            vaults: [
              {
                id: TEST_VAULT_ID,
                name: 'E2E OpCard Vault',
                path: '/tmp/e2e-op-card-vault',
                fileCount: 3,
                createdAt: Date.now(),
              },
            ],
          },
        });
      } else {
        await route.continue();
      }
    });
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    // Also remove the vault mock
    await page.unroute('**/api/knowledge/vaults');
  });

  test('shows file operation card for Write tool with diff', async ({ page }) => {
    const writeScript = [
      { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', delta: 'Let me create that file for you.' },
      {
        type: 'tool_use',
        id: 'tool-w1',
        name: 'Write',
        input: { file_path: 'notes/new-file.md', content: '# New File\n\nHello world!\n' },
      },
      { type: 'tool_result', toolUseId: 'tool-w1', content: 'File created.', isError: false },
      { type: 'text_delta', delta: ' Done.' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 50 }, costUsd: 0.005 },
    ];

    await mockChatRun(page, { script: writeScript });
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    // Send a message to trigger the chat
    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('create a file');
    await page.locator('[data-testid="composer-send"]').click();

    // Wait for the operation card to appear
    const opCard = page.locator('[data-testid="file-op-card"]');
    await expect(opCard).toBeVisible({ timeout: 8000 });

    // Should show file name
    await expect(opCard).toContainText('new-file.md');

    // [打开文件] button should be visible (vault is mocked)
    const openBtn = page.locator('[data-testid="file-op-open"]');
    await expect(openBtn).toBeVisible();

    // [查看本次修改] button should be visible (Write tool has content → diff-able)
    const diffBtn = page.locator('[data-testid="file-op-diff-toggle"]');
    await expect(diffBtn).toBeVisible();

    // [查看本次修改] should toggle DiffView
    await diffBtn.click();
    const diffView = page.locator('[data-testid="diff-view"]');
    await expect(diffView).toBeVisible();

    // Write tool (only new_string) should show all add lines
    const addLines = diffView.locator('.diff-line-add');
    const delLines = diffView.locator('.diff-line-del');
    expect(await addLines.count()).toBeGreaterThan(0);
    expect(await delLines.count()).toBe(0);

    // Click again to collapse
    await diffBtn.click();
    await expect(diffView).not.toBeVisible();

    // [💬 讨论这个文件] button should be visible
    const discussBtn = page.locator('[data-testid="file-op-discuss"]');
    await expect(discussBtn).toBeVisible();
  });

  test('Write tool is filtered from regular tool cards', async ({ page }) => {
    // Script with both a Write tool (should → operation card only) and a Read tool (should → tool card)
    const mixedScript = [
      { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', delta: 'Let me read and write.' },
      {
        type: 'tool_use',
        id: 'tool-read',
        name: 'Read',
        input: { file_path: 'notes/existing.md' },
      },
      { type: 'tool_result', toolUseId: 'tool-read', content: 'file contents', isError: false },
      {
        type: 'tool_use',
        id: 'tool-w2',
        name: 'Write',
        input: { file_path: 'notes/output.md', content: 'Generated content.' },
      },
      { type: 'tool_result', toolUseId: 'tool-w2', content: 'Created.', isError: false },
      { type: 'text_delta', delta: ' All done.' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 150, output_tokens: 60 }, costUsd: 0.008 },
    ];

    await mockChatRun(page, { script: mixedScript });
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('read and create files');
    await page.locator('[data-testid="composer-send"]').click();

    // FileOperationCard should appear for the Write tool
    const opCard = page.locator('[data-testid="file-op-card"]');
    await expect(opCard).toBeVisible({ timeout: 8000 });

    // Only ONE file-op-card (Write only, not Read)
    await expect(page.locator('[data-testid="file-op-card"]')).toHaveCount(1);

    // Verify the Read tool was rendered as a regular tool-line (not filtered out).
    // ToolCard renders non-AUQ tools as inline .tool-line elements.
    await expect(page.locator('.tool-line-name')).toBeVisible();
    await expect(page.locator('.tool-line-name')).toContainText('Read');
  });

  test('Edit tool shows diff with del/add/ctx lines', async ({ page }) => {
    const editScript = [
      { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', delta: 'Let me fix that.' },
      {
        type: 'tool_use',
        id: 'tool-e1',
        name: 'Edit',
        input: {
          file_path: 'notes/config.md',
          old_string: 'debug: true',
          new_string: 'debug: false',
        },
      },
      { type: 'tool_result', toolUseId: 'tool-e1', content: 'Updated.', isError: false },
      { type: 'text_delta', delta: ' Fixed.' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 40 }, costUsd: 0.004 },
    ];

    await mockChatRun(page, { script: editScript });
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('fix the config');
    await page.locator('[data-testid="composer-send"]').click();

    // Operation card appears
    const opCard = page.locator('[data-testid="file-op-card"]');
    await expect(opCard).toBeVisible({ timeout: 8000 });

    // Toggle diff
    await page.locator('[data-testid="file-op-diff-toggle"]').click();
    const diffView = page.locator('[data-testid="diff-view"]');
    await expect(diffView).toBeVisible();

    // Edit tool should show both del and add lines
    const addLines = diffView.locator('.diff-line-add');
    const delLines = diffView.locator('.diff-line-del');
    expect(await addLines.count()).toBe(1); // new_string: 'debug: false'
    expect(await delLines.count()).toBe(1); // old_string: 'debug: true'
  });

  test('file write tool with error status does not render operation card', async ({ page }) => {
    const errorScript = [
      { type: 'status', label: 'running', model: 'claude-sonnet-4-5' },
      { type: 'text_delta', delta: 'Let me try to write...' },
      {
        type: 'tool_use',
        id: 'tool-err',
        name: 'Write',
        input: { file_path: 'notes/fail.md', content: 'content' },
      },
      {
        type: 'tool_result',
        toolUseId: 'tool-err',
        content: 'Permission denied',
        isError: true,
      },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 30 }, costUsd: 0.003 },
    ];

    await mockChatRun(page, { script: errorScript });
    await gotoHome(page);
    await page.reload({ waitUntil: 'networkidle' });

    const composer = page.locator('[data-testid="composer-input"]');
    await composer.fill('write a file');
    await page.locator('[data-testid="composer-send"]').click();

    // Wait for the assistant message
    await page.waitForSelector('[data-testid="assistant-message"]', { timeout: 8000 });

    // No file operation card should appear (tool had error)
    await expect(page.locator('[data-testid="file-op-card"]')).toHaveCount(0);
  });
});
