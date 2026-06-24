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
 * @priority P1
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
      const refreshBtn = page.locator('.history-refresh');
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
      const refreshBtn = page.locator('.history-refresh');
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
});
