import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Companion to chat-timeout-fallback.spec — guards the IDLE-reset behavior of
 * the fallback timer. The fallback is armed on run start and reset on EVERY
 * received AgentEvent, so a long but ACTIVE run (remotion render, multi-turn
 * chat, periodic tool output) must NOT false-fire "响应超时" while events
 * are still flowing, even when the run duration exceeds the idle window.
 *
 * Regression guard for the bug where a run streaming for >5min got killed
 * mid-run by an ABSOLUTE timer that ignored activity (the timer only counted
 * down from run start, never reset on intermediate events).
 */
test.describe('Chat — idle reset prevents false timeout', () => {
  test.beforeEach(async ({ page }) => {
    // Shrink the 10min idle window to 1s so the test can prove events keep
    // the run alive PAST the window without sleeping 10min. Production never
    // sets this.
    await page.addInitScript(() => {
      (window as any).__MOLIO_TEST_FALLBACK_TIMEOUT_MS__ = 1000;
    });
  });

  test('periodic events keep the composer running past the idle window', async ({ page }) => {
    // 10 non-terminal events streamed every 300ms = ~3s of activity. The idle
    // window is 1s. An absolute timer (the old behavior) would fire at 1s and
    // surface "响应超时"; the idle-reset timer gets re-armed by each event,
    // so the run stays alive well past 1s with no error.
    const script = Array.from({ length: 10 }, () => ({ type: 'status', label: 'running' }));
    await mockChatRun(page, { script, frameDelay: 300 });
    await gotoHome(page);
    await sendMessage(page, 'hi');

    const input = page.locator('[data-testid="composer-input"]');
    // During the run the composer is disabled (isRunning=true).
    await expect(input).toBeDisabled({ timeout: 5_000 });

    // Wait PAST the 1s idle window. The run is still streaming (events arrive
    // every 300ms through ~3s), so the timer has been reset repeatedly — no
    // false timeout. The composer must still be running and no error banner
    // must have surfaced.
    await page.waitForTimeout(1_600);
    await expect(input).toBeDisabled();
    await expect(page.locator('[data-testid="assistant-error"]')).toHaveCount(0);
  });

  test.afterEach(async ({ page }) => { await unmockAll(page); });
});
