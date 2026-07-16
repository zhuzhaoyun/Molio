import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * ⋯ overflow menu: opens/closes, surfaces low-frequency actions.
 */

test.describe('Chat — overflow menu', () => {
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('⋯ opens and shows the delete action; closes on outside click', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await expect(page.locator('[data-testid="overflow-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="overflow-item-delete"]')).toBeVisible();

    // Outside click closes it. Click at (200, 10) — well clear of the NavRail (56 px
    // wide) so the mousedown lands on the empty chat-header area rather than on the
    // Home NavLink, which in some environments (Ubuntu headless Chrome) can interfere
    // with the mousedown-bubble path before the document listener fires.
    await page.locator('body').click({ position: { x: 200, y: 10 } });
    await expect(page.locator('[data-testid="overflow-menu"]')).toHaveCount(0);
  });

  test('⋯ closes on Escape', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').click();
    await expect(page.locator('[data-testid="overflow-menu"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="overflow-menu"]')).toHaveCount(0);
  });

  test('user message ⋯ shows delete', async ({ page }) => {
    await mockChatRun(page);
    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="user-message"]')).toBeVisible();

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="user-message"] [data-testid="msg-overflow-btn"]').click();
    await expect(page.locator('[data-testid="overflow-item-delete"]')).toBeVisible();
  });
});
