import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, mockDeleteMessages, unmockAll, SCRIPTS } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Delete via ⋯ → selection mode (pair pre-checked) → confirm bar.
 */

test.describe('Chat — delete', () => {
  test.afterEach(async ({ page }) => {
    await unmockAll(page);
  });

  async function twoTurns(page: import('@playwright/test').Page) {
    // Seed two user/assistant pairs by routing a second create-run as a
    // fresh run for the second send (mockChatRun returns the same runId; the
    // optimistic UI appends a second pair regardless).
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', multiTurn: true });
    await mockDeleteMessages(page);
    await gotoHome(page);
    await sendMessage(page, 'First');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
  }

  test('delete from assistant ⋯ pre-checks the assistant + its preceding user', async ({ page }) => {
    await twoTurns(page);
    // One user + one assistant so far.
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(1);

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-delete"]').click();

    // Selection mode on, confirm bar visible.
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeVisible();
    // Both bubbles show a checked checkbox.
    await expect(page.locator('[data-testid="msg-checkbox"].checked')).toHaveCount(2);

    // Confirm delete.
    await page.locator('[data-testid="selection-delete-btn"]').click();
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toHaveCount(0);
  });

  test('toggle an extra bubble on/off updates the count', async ({ page }) => {
    await twoTurns(page);

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="user-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-delete"]').click();

    // Pair (user + next assistant) pre-checked → 2
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toContainText('已选 2 条');

    // Uncheck the assistant.
    const assistantCheckbox = page.locator('[data-testid="assistant-message"] [data-testid="msg-checkbox"]');
    await assistantCheckbox.click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toContainText('已选 1 条');

    // Re-check it.
    await assistantCheckbox.click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toContainText('已选 2 条');
  });

  test('cancel exits selection mode without deleting', async ({ page }) => {
    await twoTurns(page);

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-delete"]').click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeVisible();

    await page.locator('[data-testid="selection-cancel-btn"]').click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toHaveCount(0);
    // Nothing deleted.
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
  });

  test('partial delete exits selection mode and leaves other messages', async ({ page }) => {
    await mockChatRun(page, { runId: 'run-1', conversationId: 'conv-1', multiTurn: true });
    await mockDeleteMessages(page);
    await gotoHome(page);
    await sendMessage(page, 'First');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });
    await sendMessage(page, 'Second');
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(2, { timeout: 10_000 });
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(2);

    // Delete the FIRST pair via the first assistant's ⋯.
    await page.locator('[data-testid="assistant-message"]').first().hover();
    await page.locator('[data-testid="assistant-message"]').first().locator('[data-testid="msg-overflow-btn"]').click();
    await page.locator('[data-testid="overflow-item-delete"]').click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeVisible();

    // Confirm with the default pair (first user + assistant pre-checked).
    await page.locator('[data-testid="selection-delete-btn"]').click();

    // Selection mode exits, the first pair is gone, the second pair remains.
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="msg-checkbox"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="assistant-message"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="user-message"]')).toHaveCount(1);
  });
});
