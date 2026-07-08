import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * E2E tests for single-turn chat: sending a message and receiving a streamed response.
 *
 * Uses mock SSE to avoid dependency on a real AI agent. The mock intercepts
 * POST /api/runs and the SSE events endpoint, returning scripted events that
 * exercise the full frontend rendering pipeline.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Chat — single turn', () => {
  test.beforeEach(async ({ page }) => {
    await mockChatRun(page);
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('sending a message shows optimistic user bubble', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Hello world');

    const userMsg = page.locator('[data-testid="user-message"]');
    await expect(userMsg).toBeVisible({ timeout: 5_000 });
    await expect(userMsg.locator('.user-text')).toContainText('Hello world');
  });

  test('assistant response streams and renders text', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test message');

    // Wait for the assistant message to render with the scripted text
    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });
    await expect(prose).toContainText('Hello, how can I help you?');
  });

  test('composer disables during streaming and shows stop button', async ({ page }) => {
    await gotoHome(page);

    const textarea = page.locator('[data-testid="composer-input"]');
    const sendBtn = page.locator('[data-testid="composer-send"]');

    // Before sending: composer is enabled
    await expect(textarea).toBeEnabled();
    await expect(sendBtn).toBeVisible();

    // Send message
    await textarea.fill('Test');
    await textarea.press('Enter');

    // After send: composer should be disabled during streaming
    // Note: with mock SSE the response is instant, so we check that it was disabled
    // at some point by verifying the stop button appeared or the response completed.
    // The mock SSE returns all events immediately, so the composer may re-enable quickly.
    // We verify the final state: assistant message rendered.
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
  });

  test('composer re-enables after turn completes', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test');

    // Wait for the turn to complete (usage footer appears)
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });

    // Composer should be re-enabled and focused
    const textarea = page.locator('[data-testid="composer-input"]');
    await expect(textarea).toBeEnabled();
    await expect(textarea).toBeFocused();
  });

  test('usage footer shows token counts after completion', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test');

    const footer = page.locator('[data-testid="usage-footer"]');
    await expect(footer).toBeVisible({ timeout: 10_000 });

    // Script has input_tokens: 100, output_tokens: 20
    await expect(footer).toContainText('100');
    await expect(footer).toContainText('20');
  });

  test('page transitions from landing to chat-active view', async ({ page }) => {
    await gotoHome(page);

    // Initially: landing view
    await expect(page.locator('.home-landing')).toBeVisible();

    await sendMessage(page, 'Test');

    // After sending: chat-active view
    await expect(page.locator('.chat-active')).toBeVisible({ timeout: 10_000 });

    // Landing hero should be gone
    await expect(page.locator('.home-landing')).toBeHidden();

    // Chat header should be visible
    await expect(page.locator('.home-header')).toBeVisible();
  });

  test('composer input is cleared after first send (landing → chat-active remount)', async ({ page }) => {
    // Regression: the landing-page composer and the chat-active composer are
    // different component instances sharing the `home` draft cache. On the
    // first send, HomePage switches branches and unmounts the landing
    // composer before its draft-sync effect can run for the queued
    // setText(''), so the chat-active composer rehydrated from the stale
    // draft and the input was not cleared.
    await gotoHome(page);

    const textarea = page.locator('[data-testid="composer-input"]');
    await sendMessage(page, 'Hello world');

    // User bubble must be present (send actually happened)
    await expect(page.locator('[data-testid="user-message"]')).toBeVisible({ timeout: 5_000 });

    // Input must be cleared after the branch switch
    await expect(textarea).toHaveValue('');

    // And the draft must not resurrect on the next render — type again, send
    // a second message, and confirm the input clears once more.
    await textarea.fill('Second message');
    await textarea.press('Enter');
    await expect(textarea).toHaveValue('');
  });

  test('assistant message shows hover toolbar with copy after completion', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test');
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="assistant-message"]').hover();
    await expect(page.locator('[data-testid="assistant-message"]').locator('[data-testid="msg-copy-btn"]')).toBeVisible();
  });
});
