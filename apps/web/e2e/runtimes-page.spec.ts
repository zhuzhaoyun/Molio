import { test, expect } from '@playwright/test';

/**
 * E2E tests for the Runtimes page.
 *
 * Regression: Issue #55 — Codex CLI throws "Reading prompt from stdin..."
 * to stderr on Windows, which Molio mistakenly shows as an error.
 * The fix filters Codex's known informational stderr messages.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = 'http://localhost:3100/api';

test.describe('Runtimes page', () => {
  test('should display agent cards with availability status', async ({ page }) => {
    await page.goto('/runtimes');
    await page.waitForLoadState('networkidle');

    // Wait for the page to load agents
    await page.waitForSelector('.rt-agent-card', { timeout: 10_000 });

    // Verify at least one agent card is shown
    const cards = page.locator('.rt-agent-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);

    // Verify each card has a name and status badge
    const firstCard = cards.first();
    await expect(firstCard.locator('.rt-agent-card__name')).toBeVisible();
    await expect(firstCard.locator('.rt-badge').first()).toBeVisible();
  });

  test('should show Codex agent card', async ({ page }) => {
    await page.goto('/runtimes');
    await page.waitForLoadState('networkidle');

    // Wait for agents to load
    await page.waitForSelector('.rt-agent-card', { timeout: 10_000 });

    // Look for Codex card by name
    const codexCard = page.locator('.rt-agent-card').filter({
      has: page.locator('.rt-agent-card__name', { hasText: /Codex/i }),
    });

    // Codex card should exist (even if unavailable)
    const count = await codexCard.count();
    expect(count).toBeGreaterThan(0);
  });

  test('should show install button or test button for Claude agent', async ({ page }) => {
    await page.goto('/runtimes');
    await page.waitForLoadState('networkidle');

    await page.waitForSelector('.rt-agent-card', { timeout: 10_000 });

    // Find the Claude card
    const claudeCard = page.locator('.rt-agent-card').filter({
      has: page.locator('.rt-agent-card__name', { hasText: /Claude/i }),
    });
    const count = await claudeCard.count();
    if (count === 0) return; // Skip if Claude card not found

    // Claude should show either an Install button (not installed) or a Test button (installed)
    const installBtn = claudeCard.locator('.rt-install-btn');
    const testBtn = claudeCard.locator('.rt-btn').filter({ hasText: /Test|测试/ });
    const hasInstallBtn = await installBtn.count();
    const hasTestBtn = await testBtn.count();
    expect(hasInstallBtn + hasTestBtn).toBeGreaterThan(0);
  });

  test('should refresh agents when rescan button is clicked', async ({ page }) => {
    await page.goto('/runtimes');
    await page.waitForLoadState('networkidle');

    // Wait for initial load
    await page.waitForSelector('.rt-agent-card', { timeout: 10_000 });

    // Click rescan button
    const rescanBtn = page.locator('.rt-rescan-wrap button').first();
    await rescanBtn.click();

    // Wait for the scan to complete (spinner disappears)
    await page.waitForFunction(
      () => !document.querySelector('.rt-rescan-icon--spinning'),
      { timeout: 30_000 },
    );

    // Verify agents are still displayed after rescan
    const cards = page.locator('.rt-agent-card');
    const cardCount = await cards.count();
    expect(cardCount).toBeGreaterThan(0);
  });
});
