import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, mockUpdateMessageContent, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * B5: manually edit an assistant reply (no rerun) via ⋯ → 编辑.
 */

test.describe('Chat — edit assistant reply', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('edit and save updates the assistant bubble content', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await mockUpdateMessageContent(page);

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('Hello, how can I help you?', { timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-edit"]').click();

    const textarea = page.locator('[data-testid="msg-edit-assistant-textarea"]');
    await expect(textarea).toHaveValue('Hello, how can I help you?');
    await textarea.fill('Edited reply content.');
    await page.locator('[data-testid="msg-edit-assistant-save"]').click();

    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('Edited reply content.');
    await expect(page.locator('[data-testid="assistant-prose"]')).not.toContainText('Hello, how can I help you?');
  });

  test('cancel restores the original content', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await mockUpdateMessageContent(page);

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-edit"]').click();
    await page.locator('[data-testid="msg-edit-assistant-textarea"]').fill('discard me');
    await page.locator('[data-testid="msg-edit-assistant-cancel"]').click();

    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('Hello, how can I help you?');
    await expect(page.locator('[data-testid="msg-edit-assistant-textarea"]')).toHaveCount(0);
  });

  test('save disabled when content is empty', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await mockUpdateMessageContent(page);

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-edit"]').click();
    await page.locator('[data-testid="msg-edit-assistant-textarea"]').fill('   ');
    await expect(page.locator('[data-testid="msg-edit-assistant-save"]')).toBeDisabled();
  });
});
