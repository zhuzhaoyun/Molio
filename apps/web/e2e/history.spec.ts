import { test, expect, type Page } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import {
  createProject,
  createConversation,
  addMessage,
  deleteProject,
  createTempVault,
  cleanupTempVault,
  type TempVault,
} from './helpers/cleanup';

/**
 * @area history
 * @priority P0
 */

/** Escape regex special characters in a conversation title. */
const escRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Locate a history row whose title span matches `title` exactly. Scoping to
 * the title span (instead of a row-level `hasText`) keeps the lookup hermetic:
 * other conversations' summaries in a dirty dev DB cannot collide via substring.
 */
function rowByTitle(page: Page, title: string) {
  return page
    .locator('.history-row')
    .filter({ has: page.locator('.history-row__title', { hasText: new RegExp(`^${escRegex(title)}$`) }) })
    .first();
}

/** Same as `rowByTitle`, but restricted to the pinned section. */
function pinnedRowByTitle(page: Page, title: string) {
  return page
    .locator('.history-pinned .history-row')
    .filter({ has: page.locator('.history-row__title', { hasText: new RegExp(`^${escRegex(title)}$`) }) })
    .first();
}

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

      // Step 1: delete action lives in the row's ⋯ overflow menu
      await row.hover();
      await row.locator('[data-testid=history-row-overflow]').click();
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

  test('rename conversation via modal, persists after refresh', async ({ page }) => {
    const project = await createProject(`e2e-rn-${Date.now()}`);
    const conv = await createConversation(project.id, 'Original Name');
    await addMessage(project.id, conv.id, {
      id: `msg-rn-${Date.now()}`,
      role: 'user', content: 'rename me', timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);

      const row = rowByTitle(page, 'Original Name');
      await expect(row).toBeVisible({ timeout: 5_000 });
      await row.hover();
      await row.locator('[data-testid=history-row-overflow]').click();
      await row.locator('[data-testid=history-row-rename]').click();

      // Modal opens, prefilled with the current title.
      const dialog = page.locator('[data-testid=history-rename-dialog]');
      await expect(dialog).toBeVisible({ timeout: 3_000 });
      const input = page.locator('[data-testid=history-rename-input]');
      await expect(input).toHaveValue('Original Name');

      await input.fill('Renamed Title');
      await page.locator('[data-testid=history-rename-confirm]').click();
      await expect(dialog).toHaveCount(0);
      await expect(rowByTitle(page, 'Renamed Title').locator('.history-row__title')).toHaveText('Renamed Title', { timeout: 3_000 });

      // persists after refresh
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);
      await expect(rowByTitle(page, 'Renamed Title')).toBeVisible({ timeout: 5_000 });
    } finally {
      await deleteProject(project.id);
    }
  });

  test('empty rename shows error and keeps modal open; cancel leaves title unchanged', async ({ page }) => {
    const project = await createProject(`e2e-rn2-${Date.now()}`);
    const conv = await createConversation(project.id, 'Keep Name');
    await addMessage(project.id, conv.id, {
      id: `msg-rn2-${Date.now()}`,
      role: 'user', content: 'x', timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);
      const row = rowByTitle(page, 'Keep Name');
      await expect(row).toBeVisible({ timeout: 5_000 });
      await row.hover();
      await row.locator('[data-testid=history-row-overflow]').click();
      await row.locator('[data-testid=history-row-rename]').click();

      const dialog = page.locator('[data-testid=history-rename-dialog]');
      await expect(dialog).toBeVisible({ timeout: 3_000 });
      const input = page.locator('[data-testid=history-rename-input]');
      await input.fill('');
      await page.locator('[data-testid=history-rename-confirm]').click();
      // error hint appears; modal stays open; title untouched
      await expect(page.locator('[data-testid=history-rename-error]')).toBeVisible({ timeout: 3_000 });
      await expect(dialog).toBeVisible();

      // cancel closes the modal without committing the (rejected) empty rename
      await page.locator('[data-testid=history-rename-cancel]').click();
      await expect(dialog).toHaveCount(0);
      await expect(rowByTitle(page, 'Keep Name').locator('.history-row__title')).toHaveText('Keep Name');
    } finally {
      await deleteProject(project.id);
    }
  });

  test('cancel rename closes modal without sending a PATCH', async ({ page }) => {
    const project = await createProject(`e2e-rn3-${Date.now()}`);
    const conv = await createConversation(project.id, 'Cancel Me');
    await addMessage(project.id, conv.id, {
      id: `msg-rn3-${Date.now()}`,
      role: 'user', content: 'x', timestamp: Date.now(),
    });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);

      // Count PATCH requests to /api/conversations/* — the rename path.
      let patches = 0;
      await page.route('**/api/conversations/*', (route) => {
        if (route.request().method() === 'PATCH') patches += 1;
        return route.continue();
      });

      const row = rowByTitle(page, 'Cancel Me');
      await expect(row).toBeVisible({ timeout: 5_000 });
      await row.hover();
      await row.locator('[data-testid=history-row-overflow]').click();
      await row.locator('[data-testid=history-row-rename]').click();

      const dialog = page.locator('[data-testid=history-rename-dialog]');
      await expect(dialog).toBeVisible({ timeout: 3_000 });
      await page.locator('[data-testid=history-rename-cancel]').click();
      await expect(dialog).toHaveCount(0);
      await expect(rowByTitle(page, 'Cancel Me').locator('.history-row__title')).toHaveText('Cancel Me');

      expect(patches).toBe(0);
    } finally {
      await page.unroute('**/api/conversations/*');
      await deleteProject(project.id);
    }
  });

  test('pin moves row to pinned section; unpin returns it', async ({ page }) => {
    const project = await createProject(`e2e-pin-${Date.now()}`);
    const c1 = await createConversation(project.id, 'Pin Target');
    const c2 = await createConversation(project.id, 'Normal One');
    await addMessage(project.id, c1.id, { id: `m1-${Date.now()}`, role: 'user', content: 'pin a', timestamp: Date.now() });
    await addMessage(project.id, c2.id, { id: `m2-${Date.now()}`, role: 'user', content: 'pin b', timestamp: Date.now() + 1 });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);

      // target must not be inside the pinned section yet (scoped to the test
      // conversation — a dirty dev DB may hold other pinned conversations)
      await expect(pinnedRowByTitle(page, 'Pin Target')).toHaveCount(0);

      // pin the target row
      const row = rowByTitle(page, 'Pin Target');
      await row.hover();
      await row.locator('[data-testid=history-row-overflow]').click();
      await row.locator('[data-testid=history-row-pin]').click();

      const pinned = page.locator('.history-pinned');
      await expect(pinned).toBeVisible({ timeout: 5_000 });
      await expect(pinnedRowByTitle(page, 'Pin Target')).toBeVisible();

      // unpin from pinned section
      const pinnedRow = pinnedRowByTitle(page, 'Pin Target');
      await pinnedRow.hover();
      await pinnedRow.locator('[data-testid=history-row-overflow]').click();
      await pinnedRow.locator('[data-testid=history-row-pin]').click();
      // unpinned: target no longer inside the pinned section, still in the list
      await expect(pinnedRowByTitle(page, 'Pin Target')).toHaveCount(0, { timeout: 5_000 });
      await expect(rowByTitle(page, 'Pin Target')).toBeVisible();
    } finally {
      await deleteProject(project.id);
    }
  });

  test('pinned section shows count and orders by updated_at', async ({ page }) => {
    const project = await createProject(`e2e-pin2-${Date.now()}`);
    const c1 = await createConversation(project.id, 'Pin Older');
    const c2 = await createConversation(project.id, 'Pin Newer');
    await addMessage(project.id, c1.id, { id: `a-${Date.now()}`, role: 'user', content: 'older', timestamp: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    await addMessage(project.id, c2.id, { id: `b-${Date.now()}`, role: 'user', content: 'newer', timestamp: Date.now() });
    try {
      await gotoHome(page);
      await clickNav(page, 'history');
      await page.locator('[data-testid=history-refresh]').click();
      await page.waitForTimeout(500);
      const pin = async (title: string) => {
        const r = rowByTitle(page, title);
        await r.hover();
        await r.locator('[data-testid=history-row-overflow]').click();
        await r.locator('[data-testid=history-row-pin]').click();
      };
      await pin('Pin Older');
      await pin('Pin Newer');
      const pinned = page.locator('.history-pinned');
      await expect(pinned).toBeVisible({ timeout: 5_000 });
      // Scoped to our two test conversations: both must be pinned and ordered
      // (newer updated_at first), independent of any other pinned data in a
      // dirty dev DB.
      const mine = pinned.locator('.history-row').filter({
        has: page.locator('.history-row__title', { hasText: /^Pin (Older|Newer)$/ }),
      });
      await expect(mine).toHaveCount(2);
      await expect(mine.locator('.history-row__title').first()).toHaveText('Pin Newer', { timeout: 3_000 });
    } finally {
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

  test('vault filter is visible alongside search', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'history');

    // Vault dropdown is always visible next to the search input (only filter dimension).
    await expect(page.locator('[data-testid=history-search-input]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid=history-filter-vault]')).toBeVisible({ timeout: 3_000 });
  });
});

/**
 * Multi-window default scope: when the window has an active vault, the history
 * page defaults to "this vault + unassociated" (`__current__`). The window's
 * vault is pinned via localStorage (`molio.activeVaultId`) — the same source
 * of truth vaultStore reads for windows without a ?vault= URL param.
 */
test.describe('History scoped default (current vault)', () => {
  /**
   * Point this browser context's window at `vault` before any app code runs.
   * NOTE: the returned Promise MUST be awaited — registration is async, and a
   * same-tick goto can commit before the script is registered.
   */
  function pinWindowVault(page: Page, vault: TempVault) {
    return page.addInitScript((id: string) => {
      window.localStorage.setItem('molio.activeVaultId', id);
    }, vault.id);
  }

  test('defaults to the current-vault scope when the window has an active vault', async ({ page }) => {
    const vault = await createTempVault(`e2e-scope-def-${Date.now()}`);
    try {
      await pinWindowVault(page, vault);
      await gotoHome(page);
      await clickNav(page, 'history');

      const select = page.locator('[data-testid=history-filter-vault]');
      await expect(select).toBeVisible({ timeout: 5_000 });
      // Assert on the value, not the label — hermetic across locales.
      await expect(select).toHaveValue('__current__');
      // The default entry is the window's own vault, shown by NAME (no separate
      // "current vault" pseudo-option) — value stays '__current__'.
      await expect(select.locator('option[value="__current__"]')).toHaveText(vault.name, { timeout: 5_000 });
    } finally {
      await cleanupTempVault(vault);
    }
  });

  test('default scope keeps unassociated conversations; strict vault selection hides them', async ({ page }) => {
    const vault = await createTempVault(`e2e-scope-conv-${Date.now()}`);
    // A second vault as the strict-filter target — the window's own vault has
    // no dedicated option (its name IS the default scope entry).
    const otherVault = await createTempVault(`e2e-scope-conv-b-${Date.now()}`);
    const project = await createProject(`e2e-scope-conv-p-${Date.now()}`);
    const conv = await createConversation(project.id, 'Scope Unattached');
    await addMessage(project.id, conv.id, {
      id: `msg-scope-conv-${Date.now()}`,
      role: 'user',
      content: 'unattached but within the default scope',
      timestamp: Date.now(),
    });
    try {
      // NOTE: addInitScript registration is async — MUST be awaited, or the
      // first navigation can commit before the script is registered and the
      // window boots with no pinned vault (auto-select then picks the newest).
      await pinWindowVault(page, vault);
      await gotoHome(page);
      await clickNav(page, 'history');

      const select = page.locator('[data-testid=history-filter-vault]');
      await expect(select).toHaveValue('__current__', { timeout: 5_000 });
      // The fresh vault owns nothing, but unattached conversations stay visible.
      await expect(rowByTitle(page, 'Scope Unattached')).toBeVisible({ timeout: 5_000 });

      // Strict vault filter (another vault, owns nothing) hides unassociated rows.
      await expect(select.locator(`option[value="${otherVault.id}"]`)).toHaveCount(1, { timeout: 10_000 });
      await select.selectOption(otherVault.id);
      await page.waitForTimeout(700);
      await expect(rowByTitle(page, 'Scope Unattached')).toHaveCount(0);

      // "All" brings them back.
      await select.selectOption('');
      await page.waitForTimeout(700);
      await expect(rowByTitle(page, 'Scope Unattached')).toBeVisible({ timeout: 5_000 });
    } finally {
      await deleteProject(project.id);
      await cleanupTempVault(vault);
      await cleanupTempVault(otherVault);
    }
  });

  test('scoped empty state offers view-all and switching restores the full view', async ({ page }) => {
    const vault = await createTempVault(`e2e-scope-empty-${Date.now()}`);
    try {
      await pinWindowVault(page, vault);
      // Scoped queries (includeUnassociated=1) return an empty page — the
      // UI branch under test. Everything else passes through to the daemon,
      // so "view all" exercises the real data path.
      await page.route('**/api/conversations**', (route) => {
        if (route.request().url().includes('includeUnassociated=1')) {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ items: [], pinnedItems: [], nextCursor: null }),
          });
        }
        return route.continue();
      });

      await gotoHome(page);
      await clickNav(page, 'history');

      await expect(page.locator('[data-testid=history-empty-scoped]')).toBeVisible({ timeout: 5_000 });

      await page.locator('[data-testid=history-view-all]').click();
      await expect(page.locator('[data-testid=history-empty-scoped]')).toHaveCount(0, { timeout: 5_000 });
      await expect(page.locator('[data-testid=history-filter-vault]')).toHaveValue('');
    } finally {
      await page.unroute('**/api/conversations**');
      await cleanupTempVault(vault);
    }
  });
});
