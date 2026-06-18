import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * E2E tests for the Runtimes panel (inside Settings).
 *
 * The standalone /runtimes route was removed; the RuntimePage now lives
 * as RuntimesPanel inside the Settings page, reached via the "runtimes" tab.
 *
 * Regression: Issue #55 — Codex CLI throws "Reading prompt from stdin..."
 * to stderr on Windows, which Molio mistakenly shows as an error.
 * The fix filters Codex's known informational stderr messages.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

/** Navigate to Settings → Runtimes tab and wait for the panel to render. */
async function openRuntimesPanel(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'settings');
  await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });

  // Click the "Runtimes" / "运行时" tab
  const runtimesTab = page.locator('.settings-tab-btn').filter({ hasText: /Runtime|运行时/ });
  await runtimesTab.click({ timeout: 5_000 });

  // Wait for the rt-shell to appear inside settings content
  await expect(page.locator('.rt-shell')).toBeVisible({ timeout: 5_000 });
}

test.describe('Runtimes page', () => {
  test('should display agent cards with availability status', async ({ page }) => {
    await openRuntimesPanel(page);

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
    await openRuntimesPanel(page);

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
    await openRuntimesPanel(page);

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
    await openRuntimesPanel(page);

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
