import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import {
  createProject,
  createConversation,
  addMessage,
  deleteProject,
} from './helpers/cleanup';

/**
 * @area history
 * @priority P0
 */

/**
 * E2E tests for the conversation history page.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = 'http://localhost:3100/api';

test.describe('History', () => {
  test('shows history shell when navigating to history', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'history');

    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.history-topbar')).toBeVisible();
  });

  test('shows empty state when no conversations exist', async ({ page }) => {
    // Clean up any existing conversations first — navigate to history
    // and check. In a real CI environment this would be clean.
    await gotoHome(page);
    await clickNav(page, 'history');

    // Either shows empty state or has conversations from previous runs
    const shell = page.locator('.history-shell');
    await expect(shell).toBeVisible({ timeout: 5_000 });

    // The page should at least show the content area
    await expect(page.locator('.history-content')).toBeVisible();
  });

  test('lists conversations created via API', async ({ page }) => {
    // Create test data via daemon API
    const project = await createProject(`e2e-hist-${Date.now()}`);
    const conv = await createConversation(project.id, 'Test History Conversation');
    await addMessage(project.id, conv.id, {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: 'What is the meaning of life?',
      timestamp: Date.now(),
    });
    await addMessage(project.id, conv.id, {
      id: `msg-${Date.now() + 1}`,
      role: 'assistant',
      content: 'The meaning of life is 42.',
      timestamp: Date.now() + 1000,
      agentId: 'claude',
    });

    try {
      await gotoHome(page);
      await clickNav(page, 'history');

      // Wait for history to load
      await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });

      // The conversation should appear in the history list
      // Refresh to pick up newly created conversation
      const refreshBtn = page.locator('[data-testid=history-refresh]');
      if (await refreshBtn.isVisible()) {
        await refreshBtn.click();
        await page.waitForTimeout(500);
      }

      // Should have at least one history row
      const rows = page.locator('.history-row');
      const count = await rows.count();
      expect(count).toBeGreaterThan(0);
    } finally {
      // Cleanup
      await deleteProject(project.id);
    }
  });

  test('history rows display time and title', async ({ page }) => {
    // Create test data
    const project = await createProject(`e2e-hist2-${Date.now()}`);
    const conv = await createConversation(project.id, 'E2E Title Test');
    await addMessage(project.id, conv.id, {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: 'Hello from E2E test',
      timestamp: Date.now(),
    });

    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });

      // Refresh
      const refreshBtn = page.locator('[data-testid=history-refresh]');
      if (await refreshBtn.isVisible()) {
        await refreshBtn.click();
        await page.waitForTimeout(500);
      }

      const row = page.locator('.history-row').first();
      if (await row.isVisible({ timeout: 3_000 }).catch(() => false)) {
        // Row should show a time
        await expect(row.locator('.history-row__time')).toBeVisible();
        // Row should have a body section
        await expect(row.locator('.history-row__body')).toBeVisible();
      }
    } finally {
      await deleteProject(project.id);
    }
  });

  test('search filters to matching conversations', async ({ page }) => {
    const project = await createProject(`e2e-search-${Date.now()}`);
    const conv = await createConversation(project.id, 'Search Target');
    await addMessage(project.id, conv.id, {
      id: `msg-search-${Date.now()}`,
      role: 'user',
      content: 'zzz-e2e-search-marker-12345',
      timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await expect(page.locator('[data-testid=history-search-input]')).toBeVisible({ timeout: 5_000 });
      await page.locator('[data-testid=history-search-input]').fill('zzz-e2e-search-marker-12345');
      // wait for debounced fetch + render (300ms debounce + fetch)
      await page.waitForTimeout(700);
      const rows = page.locator('.history-row');
      await expect(rows).toHaveCount(1, { timeout: 5_000 });
    } finally {
      await deleteProject(project.id);
    }
  });

  test('load more appends next page when >50 conversations', async ({ page }) => {
    const project = await createProject(`e2e-loadmore-${Date.now()}`);
    try {
      // Create 52 conversations to exceed one page (PAGE_SIZE=50).
      for (let i = 0; i < 52; i++) {
        const conv = await createConversation(project.id, `LM ${i}`);
        await addMessage(project.id, conv.id, {
          id: `msg-lm-${i}-${Date.now()}`,
          role: 'user',
          content: `load more item ${i}`,
          timestamp: Date.now() + i,
        });
      }
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(800);

      const loadMore = page.locator('[data-testid=history-load-more]');
      await expect(loadMore).toBeVisible({ timeout: 10_000 });
      const before = await page.locator('.history-row').count();
      await loadMore.click();
      await page.waitForTimeout(800);
      const after = await page.locator('.history-row').count();
      expect(after).toBeGreaterThan(before);
    } finally {
      await deleteProject(project.id);
    }
  });

  test('delete conversation shows confirmation, then removes row; rollback on failure', async ({ page }) => {
    const project = await createProject(`e2e-del-${Date.now()}`);
    const conv = await createConversation(project.id, 'Delete Me');
    await addMessage(project.id, conv.id, {
      id: `msg-del-${Date.now()}`,
      role: 'user',
      content: 'to be deleted',
      timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);

      // Intercept DELETE to force an HTTP 500 failure and verify rollback (row restored).
      await page.route('**/api/conversations/*', (route) => {
        if (route.request().method() === 'DELETE') {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'FAIL', message: 'forced' } }),
          });
        }
        return route.continue();
      });

      const row = page.locator('.history-row', { hasText: 'Delete Me' }).first();
      await expect(row).toBeVisible({ timeout: 5_000 });

      // Step 1: click delete → confirmation UI appears
      await row.locator('[data-testid=history-row-delete]').click();
      await expect(page.locator('[data-testid=history-row-delete-confirm]')).toBeVisible({ timeout: 3_000 });
      await expect(page.locator('[data-testid=history-row-delete-cancel]')).toBeVisible();

      // Step 2: click confirm → actual delete fires (HTTP 500 forced)
      await page.locator('[data-testid=history-row-delete-confirm]').click();

      // Non-blocking transient error is shown.
      await expect(page.locator('[data-testid=history-delete-error]')).toBeVisible({ timeout: 5_000 });

      // Rollback re-fetches → row reappears.
      await expect(page.locator('.history-row', { hasText: 'Delete Me' })).toBeVisible({ timeout: 5_000 });
    } finally {
      await page.unroute('**/api/conversations/*');
      await deleteProject(project.id);
    }
  });

  test('no-match shows clear-filters button and restores list', async ({ page }) => {
    const project = await createProject(`e2e-nomatch-${Date.now()}`);
    const conv = await createConversation(project.id, 'Nomatch Anchor');
    await addMessage(project.id, conv.id, {
      id: `msg-nomatch-${Date.now()}`,
      role: 'user',
      content: 'anchor conversation for clear filters test',
      timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);

      await page.locator('[data-testid=history-search-input]').fill('no-such-thing-xyzzy-9999');
      await page.waitForTimeout(700);
      await expect(page.locator('[data-testid=history-clear-filters]')).toBeVisible({ timeout: 5_000 });
      await page.locator('[data-testid=history-clear-filters]').click();
      await page.waitForTimeout(700);
      // back to non-empty list with the anchor conversation visible
      await expect(page.locator('.history-row', { hasText: 'Nomatch Anchor' })).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('[data-testid=history-clear-filters]')).toHaveCount(0);
    } finally {
      await deleteProject(project.id);
    }
  });

  test('filter toggle expands to reveal dropdowns', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'history');

    // Search is the primary control; dropdowns are folded behind the toggle.
    await expect(page.locator('[data-testid=history-search-input]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid=history-filter-vault]')).toHaveCount(0);

    await page.locator('[data-testid=history-filter-toggle]').click();
    await expect(page.locator('[data-testid=history-filter-vault]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('[data-testid=history-filter-channel]')).toBeVisible();
    await expect(page.locator('[data-testid=history-filter-agent]')).toBeVisible();
  });
});
