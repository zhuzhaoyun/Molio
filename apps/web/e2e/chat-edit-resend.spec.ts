import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, mockRewindResend, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Edit last user message and resend.
 */

test.describe('Chat — edit & resend', () => {
  // Centralized cleanup: if a test fails before reaching its inline unroute,
  // the mock routes would leak into sibling tests. afterEach always runs.
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('edit last user message truncates and re-runs', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await mockRewindResend(page, 'run-2', 'conv-1', SCRIPTS.regenerateReply);

    await gotoHome(page);
    await sendMessage(page, 'original question');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="msg-edit-btn"]').click();

    const textarea = page.locator('[data-testid="msg-edit-textarea"]');
    await expect(textarea).toHaveValue('original question');
    await textarea.fill('edited question');
    await page.locator('[data-testid="msg-edit-save"]').click();

    // New reply appears; user text updated.
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('fresh, different answer', { timeout: 10_000 });
    await expect(page.locator('[data-testid="user-message"] .user-text')).toContainText('edited question');
  });

  test('cancel edit restores original text', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await gotoHome(page);
    await sendMessage(page, 'keep me');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="msg-edit-btn"]').click();
    // Edit actions render localized labels, not raw i18n keys.
    await expect(page.locator('[data-testid="msg-edit-save"]')).toContainText('保存');
    await expect(page.locator('[data-testid="msg-edit-cancel"]')).toContainText('取消');
    await page.locator('[data-testid="msg-edit-textarea"]').fill('discard me');
    await page.locator('[data-testid="msg-edit-cancel"]').click();

    await expect(page.locator('[data-testid="user-message"] .user-text')).toContainText('keep me');
    await expect(page.locator('[data-testid="msg-edit-textarea"]')).toHaveCount(0);
  });

  test('save disabled when edit content is empty', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await gotoHome(page);
    await sendMessage(page, 'something');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="msg-edit-btn"]').click();
    await page.locator('[data-testid="msg-edit-textarea"]').fill('   ');
    await expect(page.locator('[data-testid="msg-edit-save"]')).toBeDisabled();
  });
});
