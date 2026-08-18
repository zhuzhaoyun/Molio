import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Frontend timeout fallback (W3): when the daemon crashes or hangs without
 * sending a terminal event (status completed/failed/canceled), the frontend
 * must unlock the input on its own instead of leaving the spinner spinning
 * forever. Two paths handle this:
 *   1. SSE onerror with readyState CLOSED → close + onDone → isRunning=false
 *      (fires when the daemon explicitly closes the connection or the server
 *      returns a non-200/non-event-stream response that fails EventSource
 *      permanently).
 *   2. 300s fallback timer in beginNewRun → force-unlock. Catches the more
 *      common daemon-crash case where EventSource auto-reconnects forever
 *      (readyState stays CONNECTING, so path 1 never fires).
 *
 * This test exercises path 2 (fallback timer) via a test hook that shortens
 * the timeout. Path 1 shares the same unlock callback, so it's implicitly
 * covered.
 */
test.describe('Chat — timeout fallback (W3)', () => {
  test.beforeEach(async ({ page }) => {
    // Shorten the 300s fallback to 2s so the test doesn't sleep 5min.
    // Production never sets this.
    await page.addInitScript(() => {
      (window as any).__MOLIO_TEST_FALLBACK_TIMEOUT_MS__ = 2000;
    });
  });

  test('fallback timer unlocks the composer when no terminal event arrives', async ({ page }) => {
    // Script: only a status:running event, then nothing. Simulates the daemon
    // hanging mid-run (no turn_end, no error, no usage). The mock's
    // frameDelay streams the single frame, then the connection closes — but
    // EventSource auto-reconnects, so onDone doesn't fire. The fallback timer
    // is the only path that unlocks the input.
    const script = [
      { type: 'status', label: 'running' },
    ];
    await mockChatRun(page, { script, frameDelay: 100 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    // Must be enabled WHILE the run is live. The 2s fallback would also unlock
    // it, so a 500ms window (below the fallback) keeps this assertion
    // discriminating: old code (disabled during run) fails it, new code
    // (never disabled) passes it immediately.
    const input = page.locator('[data-testid="composer-input"]');
    await expect(page.locator('[data-testid="composer-stop"]')).toBeVisible({ timeout: 5_000 });
    await expect(input).toBeEnabled({ timeout: 500 });

    // After the fallback timer (2s via test hook), the run force-unlocks:
    // the stop button disappears and an error message surfaces on the
    // assistant bubble.
    await expect(page.locator('[data-testid="composer-stop"]')).toBeHidden({ timeout: 5_000 });
    await expect(page.locator('[data-testid="assistant-error"]'))
      .toContainText('响应超时', { timeout: 2_000 });
  });

  test.afterEach(async ({ page }) => { await unmockAll(page); });
});
