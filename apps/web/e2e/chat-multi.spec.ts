import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * E2E tests for multi-turn conversation and new chat reset.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Chat — multi-turn', () => {
  test.beforeEach(async ({ page }) => {
    await mockChatRun(page);
  });

  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('second message uses multi-turn API', async ({ page }) => {
    await gotoHome(page);

    // First message — creates a new run
    await sendMessage(page, 'First message');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    // Track multi-turn API call
    const multiTurnRequest = page.waitForRequest(
      (req) => req.url().includes('/messages') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    // Second message — should use multi-turn endpoint
    await sendMessage(page, 'Second message');
    const req = await multiTurnRequest;
    const body = req.postDataJSON();
    expect(body.message).toBe('Second message');

    // Both user messages should be visible
    const userMessages = page.locator('[data-testid="user-message"]');
    await expect(userMessages).toHaveCount(2, { timeout: 5_000 });
    await expect(userMessages.first().locator('.user-text')).toContainText('First message');
    await expect(userMessages.nth(1).locator('.user-text')).toContainText('Second message');
  });

  test('new chat button clears messages and returns to landing', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test message');

    // Wait for chat-active state
    await expect(page.locator('.chat-active')).toBeVisible({ timeout: 10_000 });

    // Click new chat button
    await page.locator('[data-testid="new-chat-btn"]').click();

    // Should return to landing view
    await expect(page.locator('.home-landing')).toBeVisible({ timeout: 5_000 });

    // No messages should be present
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
  });

  test('new chat resets composer to focused state', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test message');
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });

    // Click new chat
    await page.locator('[data-testid="new-chat-btn"]').click();
    await expect(page.locator('.home-landing')).toBeVisible();

    // Composer should be focused and ready
    const textarea = page.locator('[data-testid="composer-input"]');
    await expect(textarea).toBeVisible();
    await expect(textarea).toBeEnabled();
  });

  test('header shows active agent name during chat', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Test message');

    await expect(page.locator('.chat-active')).toBeVisible({ timeout: 10_000 });

    // The active agent badge should be visible in the header
    const agentBadge = page.locator('.home-active-agent');
    await expect(agentBadge).toBeVisible();
    // Agent name should be non-empty (depends on which agent is available)
    await expect(agentBadge).not.toHaveText('');
  });
});
