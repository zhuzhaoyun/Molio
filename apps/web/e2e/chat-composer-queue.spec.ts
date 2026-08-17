import { test, expect } from '@playwright/test';
import { gotoHome } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * Queue semantics while the AI is replying: the composer stays enabled, a
 * message sent mid-reply appears immediately with a "排队中" badge, and is
 * dispatched after the current turn ends. The drained turn streams real
 * content over the same SSE connection (secondTurnScripts), so the spec can
 * assert per-bubble content — not just that a second bubble appeared.
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
    await mockChatRun(page, {
      script,
      frameDelay: 700,
      secondTurnScripts: [[
        { type: 'status', label: 'running' },
        { type: 'text_delta', delta: 'Second reply, ' },
        { type: 'text_delta', delta: 'done.' },
        { type: 'turn_end', stopReason: 'end_turn' },
        { type: 'usage', usage: { input_tokens: 50, output_tokens: 10 }, costUsd: 0.002 },
      ]],
    });
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

    // 6) When the turn ends the queued message drains: the drained turn streams
    //    real content over the same SSE connection (second assistant bubble).
    const assistantMsgs = page.locator('[data-testid="assistant-message"]');
    await expect(assistantMsgs).toHaveCount(2, { timeout: 10_000 });
    await expect(assistantMsgs.nth(1)).toContainText('Second reply, done.');
    await expect(page.locator('[data-testid="msg-queued-badge"]')).toHaveCount(0);
    // The drained turn's usage footer (turn 2's) — turn 1's trailing usage is
    // orphaned (it lands after the drain retargets to the streaming bubble, so
    // the streaming guard ignores it), leaving exactly one usage footer.
    await expect(page.locator('[data-testid="usage-footer"]')).toHaveCount(1, { timeout: 10_000 });
    await expect(textarea).toBeEnabled();
  });

  test('two messages queued during one reply drain in order without scrambling content', async ({ page }) => {
    // Turn 1 reply (5 frames). Two messages are queued mid-turn; the drained
    // turns stream distinct text so a scramble (turn N's content landing in
    // turn N+1's bubble, or a reply dropped entirely) is caught.
    const script = [
      { type: 'status', label: 'running' },
      { type: 'text_delta', delta: 'First reply, ' },
      { type: 'text_delta', delta: 'streaming.' },
      { type: 'turn_end', stopReason: 'end_turn' },
      { type: 'usage', usage: { input_tokens: 100, output_tokens: 20 }, costUsd: 0.005 },
    ];
    await mockChatRun(page, {
      script,
      frameDelay: 700,
      secondTurnScripts: [
        [
          { type: 'status', label: 'running' },
          { type: 'text_delta', delta: 'Second reply, ' },
          { type: 'text_delta', delta: 'done.' },
          { type: 'turn_end', stopReason: 'end_turn' },
          { type: 'usage', usage: { input_tokens: 50, output_tokens: 10 }, costUsd: 0.002 },
        ],
        [
          { type: 'status', label: 'running' },
          { type: 'text_delta', delta: 'Third reply, ' },
          { type: 'text_delta', delta: 'done.' },
          { type: 'turn_end', stopReason: 'end_turn' },
          { type: 'usage', usage: { input_tokens: 60, output_tokens: 12 }, costUsd: 0.003 },
        ],
      ],
    });
    await gotoHome(page);

    const textarea = page.locator('[data-testid="composer-input"]');
    const stopBtn = page.locator('[data-testid="composer-stop"]');
    const userMsgs = page.locator('[data-testid="user-message"]');

    // 1) Send the first message → run starts.
    await textarea.fill('First');
    await textarea.press('Enter');
    await expect(stopBtn).toBeVisible({ timeout: 5_000 });

    // 2) Queue message 2 while turn 1 is running.
    await textarea.fill('Second (queued)');
    await textarea.press('Enter');
    await expect(userMsgs).toHaveCount(2);

    // 3) Queue message 3 while turn 1 is STILL running.
    await textarea.fill('Third (queued)');
    await textarea.press('Enter');
    await expect(userMsgs).toHaveCount(3);
    await expect(page.locator('[data-testid="msg-queued-badge"]')).toHaveCount(2);

    // 4) Both queued messages drain in order, each with its own distinct reply.
    const assistantMsgs = page.locator('[data-testid="assistant-message"]');
    await expect(assistantMsgs).toHaveCount(3, { timeout: 15_000 });
    await expect(assistantMsgs.nth(1)).toContainText('Second reply, done.');
    await expect(assistantMsgs.nth(2)).toContainText('Third reply, done.');
    await expect(page.locator('[data-testid="msg-queued-badge"]')).toHaveCount(0);
  });
});
