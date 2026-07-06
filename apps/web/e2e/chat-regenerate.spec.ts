import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, mockRewindResend, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Regenerate last assistant message.
 */

test.describe('Chat — regenerate', () => {
  test('regenerate replaces the last assistant reply', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1' });
    await mockRewindResend(page, 'run-2', 'conv-1', SCRIPTS.regenerateReply);

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('Hello, how can I help you?', { timeout: 10_000 });

    // No regenerate button while streaming is done (mock is instant); the button
    // appears on the last assistant message after the turn completes.
    await page.locator('[data-testid="assistant-message"]').last().hover();
    await page.locator('[data-testid="msg-regenerate-btn"]').click();

    // Old reply is gone; new (different) reply appears.
    await expect(page.locator('[data-testid="assistant-prose"]')).toContainText('fresh, different answer', { timeout: 10_000 });
    await expect(page.locator('[data-testid="assistant-prose"]')).not.toContainText('Hello, how can I help you?');

    await unmockAll(page);
    await page.unroute('**/api/runs/run-2/events**');
  });

  test('regenerate button hidden on non-last assistant messages', async ({ page }) => {
    // Multi-turn: two assistant messages; only the last shows regenerate.
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', multiTurn: true });
    await gotoHome(page);
    await sendMessage(page, 'First');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
    await sendMessage(page, 'Second');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 10_000 });

    // Only one regenerate button (on the last).
    await expect(page.locator('[data-testid="msg-regenerate-btn"]')).toHaveCount(1);

    await unmockAll(page);
  });
});
