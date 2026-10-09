/**
 * Navigation helpers for E2E tests.
 * Centralises common page.goto + wait patterns.
 */
import { expect, type Page } from '@playwright/test';

/** Navigate to home and wait for the app shell instead of persistent SSE/HMR. */
export async function gotoHome(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-view="knowledge"]')).toBeVisible({ timeout: 20_000 });
}

/** Click a NavRail button by its data-view attribute. */
export async function clickNav(page: Page, view: string) {
  await page.locator(`[data-view="${view}"]`).click();
  // SPA navigation is instant — no need for networkidle.
  // Callers should assert on specific elements for readiness.
}

/** Type a message into the composer and press Enter. */
export async function sendMessage(page: Page, text: string) {
  const textarea = page.locator('[data-testid="composer-input"]');
  await textarea.fill(text);
  await textarea.press('Enter');
}

/** Wait for the landing page to be fully rendered. */
export async function waitForLanding(page: Page) {
  await page.waitForSelector('.home-landing', { state: 'visible' });
}

/** Wait for the chat-active view to appear (after sending a message). */
export async function waitForChatActive(page: Page) {
  await page.waitForSelector('.chat-active', { state: 'visible' });
}
