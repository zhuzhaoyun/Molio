import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Queue semantics while the AI is replying: the composer stays enabled, a
 * message sent mid-reply appears immediately with a "排队中" badge, and is
 * dispatched after the current turn ends.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173).
 */
test.describe('Chat — composer queue while running', () => {
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('message sent during a reply is queued, badged, then dispatched after turn_end', async ({ page }) => {
    // 5 frames × 700ms ≈ 3.5s running window: long enough to observe the
    // "running" state and queue a second message mid-turn, short enough to
    // keep the test snappy. The run ends with turn_end + usage.
    const script = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: 'First reply, ' },
      { type: 'text_delta', delta: 'still streaming.' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.005 },
    ];
    await mockChatRun(page, { script, frameDelay: 700 });
    await gotoHome(page);

    const textarea = page.locator('[data-testid="composer-input"]');
    const stopBtn = page.locator('[data-testid="composer-stop"]');
    const sendBtn = page.locator('[data-testid="composer-send"]');

    // 1) Send the first message → run starts (stop button marks running).
    await textarea.fill('First');
    await textarea.press('Enter');
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });

    // 2) While running the composer stays ENABLED.
    await expect(textarea).toBeEnabled();

    // 3) Type a second message → the send button reappears next to Stop.
    await textarea.fill('Second (queued)');
    await expect(sendBtn).toBeVisible();

    // 4) Send it mid-reply → it appears immediately WITH the queued badge.
    await textarea.press('Enter');
    const userMsgs = page.locator('[data-testid="user-message"]');
    await expect(userMsgs).toHaveCount(2);
    await expect(userMsgs.nth(1)).toContainText('Second (queued)');
    await expect(page.locator('[data-testid="msg-queued-badge"]')).toBeVisible();

    // 5) The run keeps going and the composer stays usable.
    await expect(stopBtn).toBeVisible();
    await expect(textarea).toBeEnabled();

    // 6) When the turn ends (usage footer), the badge clears and the queued
    //    message is dispatched (a second assistant message appears).
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="msg-queued-badge"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2);
    await expect(textarea).toBeEnabled();
  });
});
