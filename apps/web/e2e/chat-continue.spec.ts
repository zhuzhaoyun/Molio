import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * "Continue generating" on the last assistant message sends a 继续 follow-up
 * turn (new user bubble + new assistant reply) — does not append to the
 * original bubble, to stay consistent with the daemon's persisted history.
 */

test.describe('Chat — continue generating', () => {
  test('continue button sends a 继续 follow-up turn', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', multiTurn: true });

    // Capture the multi-turn POST so we can assert the prompt + that it fired.
    let multiTurnBody: { message?: string } | null = null;
    await page.route('**/api/runs/run-1/messages', async (route) => {
      try {
        multiTurnBody = JSON.parse(route.request().postData() || '{}');
      } catch { /* ignore */ }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    // Continue button only shows on the last assistant message after the turn.
    await page.locator('[data-testid="assistant-message"]').last().hover();
    await page.locator('[data-testid="msg-continue-btn"]').click();

    // A user bubble with "继续" is appended (the last user message).
    await expect(page.locator('[data-testid="user-message"]').last().locator('.user-text')).toContainText('继续');

    // The multi-turn endpoint was actually hit with the 继续 prompt.
    expect(multiTurnBody?.message).toBe('继续');

    await unmockAll(page);
    await page.unroute('**/api/runs/run-1/messages');
  });

  test('continue button hidden on non-last assistant messages', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', multiTurn: true });
    await gotoHome(page);
    await sendMessage(page, 'First');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
    await sendMessage(page, 'Second');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 10_000 });

    // Only the last assistant message shows the continue button.
    await expect(page.locator('[data-testid="msg-continue-btn"]')).toHaveCount(1);

    await unmockAll(page);
  });
});
