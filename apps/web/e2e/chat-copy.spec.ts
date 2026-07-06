import { test, expect } from '@playwright/test';
import { gotoHome, sendMessage } from './helpers/navigation';
import { mockChatRun, unmockAll } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P0
 *
 * Copy buttons on assistant and user messages, and code-block copy.
 */

test.describe('Chat — copy', () => {
  test.beforeEach(async ({ page }) => {
    // Intercept clipboard.writeText to capture copied text (Playwright headless
    // may not grant clipboard read without permissions).
    await page.addInitScript(() => {
      (window as any).__copied = '';
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (t: string) => { (window as any).__copied = t; } },
        configurable: true,
      });
    });
    await mockChatRun(page);
  });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('copy assistant message copies raw markdown content', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Hello');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    await page.locator('[data-testid="assistant-message"] [data-testid="msg-copy-btn"]').click();

    const copied = await page.evaluate(() => (window as any).__copied as string);
    expect(copied).toContain('Hello, how can I help you?');
  });

  test('copy user message copies user text', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'My question');
    await expect(page.locator('[data-testid="user-message"]')).toBeVisible();

    await page.locator('[data-testid="user-message"]').hover();
    await page.locator('[data-testid="user-message"] [data-testid="msg-copy-btn"]').click();

    const copied = await page.evaluate(() => (window as any).__copied as string);
    expect(copied).toContain('My question');
  });

  test('copy button shows transient copied state', async ({ page }) => {
    await gotoHome(page);
    await sendMessage(page, 'Hi');
    await expect(page.locator('[data-testid="assistant-prose"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="assistant-message"]').hover();
    const btn = page.locator('[data-testid="assistant-message"] [data-testid="msg-copy-btn"]');
    await btn.click();
    // Icon-only button: copied state surfaces as the .copied class and a
    // tooltip whose data-tip flips to "已复制" (no inline text on the button).
    await expect(btn).toHaveClass(/copied/);
    await expect(btn).toHaveAttribute('data-tip', '已复制');
  });
});
