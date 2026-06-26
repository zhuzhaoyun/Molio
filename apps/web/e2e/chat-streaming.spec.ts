import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * E2E tests for SSE event rendering details: thinking blocks, tool use, errors.
 *
 * Each test uses a specific script that exercises different event types.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Chat — streaming details', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  test('thinking block renders and is collapsible', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withThinking });
    await gotoHome(page);
    await sendMessage(page, 'Analyze this');

    // Thinking block should appear
    const thinking = page.locator('[data-testid="thinking-block"]');
    await expect(thinking).toBeVisible({ timeout: 10_000 });

    // Header should show "Thinking" label
    await expect(thinking.locator('.thinking-header')).toBeVisible();

    // Initially collapsed — content not visible
    await expect(thinking.locator('.thinking-content')).toBeHidden();

    // Click to expand
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeVisible();
    await expect(thinking.locator('.thinking-content')).toContainText('Let me analyze this...');

    // Click to collapse again
    await thinking.locator('.thinking-header').click();
    await expect(thinking.locator('.thinking-content')).toBeHidden();
  });

  test('tool use renders inline with name and status', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    // Wait for the response to complete
    await expect(page.locator('[data-testid="usage-footer"]')).toBeVisible({ timeout: 10_000 });

    // Tool line should be visible with the tool name
    const toolLine = page.locator('.tool-line');
    await expect(toolLine).toBeVisible();
    await expect(toolLine.locator('.tool-line-name')).toContainText('Read');

    // Status should show done (✓)
    await expect(toolLine.locator('.tool-line-status')).toContainText('✓');
  });

  test('assistant prose contains text before and after tool use', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withToolUse });
    await gotoHome(page);
    await sendMessage(page, 'Read a file');

    const prose = page.locator('[data-testid="assistant-prose"]');
    await expect(prose).toBeVisible({ timeout: 10_000 });

    // Script emits: "Let me check that file." → tool_use → " The file looks good."
    await expect(prose).toContainText('Let me check that file.');
    await expect(prose).toContainText('The file looks good.');
  });

  test('error event shows in assistant message', async ({ page }) => {
    await mockChatRun(page, { script: SCRIPTS.withError });
    await gotoHome(page);
    await sendMessage(page, 'Trigger error');

    // Wait for assistant message to render
    const assistantMsg = page.locator('[data-testid="assistant-message"]');
    await expect(assistantMsg).toBeVisible({ timeout: 10_000 });

    // Error text should appear in the message
    await expect(assistantMsg).toContainText('Something went wrong', { timeout: 5_000 });
  });
});
