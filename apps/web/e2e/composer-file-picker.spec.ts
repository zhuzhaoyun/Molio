import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TempVault } from './helpers/cleanup';
import { mockAgent } from './helpers/mock-sse';

/**
 * @area chat
 * @priority P1
 *
 * E2E for the composer "@" file ref picker (Claude Code-style inline refs).
 *
 * The picker is a drill-down navigator: browse mode shows the current dir's
 * children (folder first, breadcrumb at top); search mode flat-filters the
 * whole tree. A folder row has TWO actions — main click/Enter drills in, the
 * row-tail "@" button / Shift+Enter references the folder itself (no drill).
 *
 * We pin a vault via `?vault=` so the tree is deterministic (the home page
 * auto-selects whatever vault sorts first, which is not our test vault).
 */

const DAEMON = 'http://localhost:3100';

let vault: TempVault;

/** Build a known, ASCII-named vault tree on disk, then register it. */
async function createVaultWithTree(): Promise<TempVault> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-e2e-'));
  fs.writeFileSync(path.join(dir, 'top.md'), '# Top\n');
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'audio', 'song.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Guide\n');
  const name = `e2e-file-picker-${Date.now()}`;
  const res = await fetch(`${DAEMON}/api/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: dir }),
  });
  const v = await res.json();
  return { id: v.id, path: dir, name };
}

async function gotoHomeWithVault(page: import('@playwright/test').Page) {
  await page.goto(`/?vault=${vault.id}`);
  await Promise.race([
    page.waitForLoadState('networkidle'),
    page.waitForTimeout(5_000),
  ]);
}

/** Open the picker by typing @ in the composer. */
async function openPicker(page: import('@playwright/test').Page) {
  const input = page.locator('[data-testid="composer-input"]');
  await expect(input).toBeVisible();
  await input.fill('@');
  const picker = page.locator('[data-testid="file-picker"]');
  await expect(picker).toBeVisible({ timeout: 5_000 });
  return picker;
}

function item(page: import('@playwright/test').Page, text: string) {
  return page
    .locator('[data-testid="file-picker-item"]')
    .filter({ has: page.locator('.file-picker-item-name', { hasText: text }) })
    .first();
}

test.beforeAll(async () => {
  vault = await createVaultWithTree();
});

test.afterAll(async () => {
  if (vault) {
    await fetch(`${DAEMON}/api/knowledge/vaults/${vault.id}`, { method: 'DELETE' });
    try { fs.rmSync(vault.path, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test.describe('Composer @ file picker (drill-down)', () => {
  // Mock a usable agent so the composer renders on a runtime-less CI runner
  // (otherwise the NoRuntimeCard replaces it and the picker can't be opened).
  test.beforeEach(async ({ page }) => {
    await mockAgent(page);
  });

  test('typing @ opens the picker in browse mode: folders first, breadcrumb at root', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);

    // Top-level folders (audio, docs) sort before the root file (top.md).
    for (const name of ['audio', 'docs']) {
      await expect(item(page, name)).toBeVisible();
    }
    // Breadcrumb shows just "根" at the vault root.
    const breadcrumb = page.locator('[data-testid="file-picker-breadcrumb"]');
    await expect(breadcrumb).toContainText('根');
  });

  test('clicking a folder drills into it and shows its children', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);

    await item(page, 'docs').click();

    // Breadcrumb now shows the drilled folder; the folder's file is listed.
    const breadcrumb = page.locator('[data-testid="file-picker-breadcrumb"]');
    await expect(breadcrumb).toContainText('docs');
    await expect(item(page, 'guide.md')).toBeVisible();
  });

  test('the folder "@" reference button commits the folder without drilling', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);

    const docsItem = item(page, 'docs');
    await docsItem.hover();
    const refBtn = docsItem.locator('[data-testid="file-picker-ref-btn"]');
    await expect(refBtn).toBeVisible();
    await refBtn.click();

    // Committed an inline ref to the folder (trailing slash) — no drill.
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toHaveValue('@docs/');
    await expect(page.locator('[data-testid="file-picker"]')).not.toBeVisible();
  });

  test('Shift+Enter on a folder references it without drilling', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);
    // Wait for the list to finish loading — a key pressed mid-load is ignored
    // by the picker's `if (loading) return` guard.
    await expect(item(page, 'audio')).toBeVisible();

    // First dir (audio) is the default-highlighted row (index 0). Shift+Enter
    // is the reference action — it must NOT drill. Down/Enter/Up is explicit so
    // the modifier is guaranteed held during the Enter keydown.
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');

    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toHaveValue('@audio/');
    await expect(page.locator('[data-testid="file-picker"]')).not.toBeVisible();
  });

  test('Esc goes up a level from inside a folder (not closing the picker)', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);

    await item(page, 'audio').click();
    await expect(page.locator('[data-testid="file-picker-breadcrumb"]')).toContainText('audio');

    await page.keyboard.press('Escape');

    // Back to vault root: breadcrumb root, root file visible, picker still open.
    await expect(page.locator('[data-testid="file-picker"]')).toBeVisible();
    await expect(page.locator('[data-testid="file-picker-breadcrumb"]')).toContainText('根');
    await expect(item(page, 'top.md')).toBeVisible();
  });

  test('committing a file ref keeps the picker closed (re-trigger regression)', async ({ page }) => {
    await gotoHomeWithVault(page);
    await openPicker(page);

    await item(page, 'top.md').click();
    const input = page.locator('[data-testid="composer-input"]');
    await expect(input).toHaveValue('@top.md');
    await expect(page.locator('[data-testid="file-picker"]')).not.toBeVisible();

    // A later keypress/cursor move must NOT pop the picker back open (the old
    // keyup/mouseup re-match bug that made folder selection "stuck").
    await input.press('ArrowRight');
    await expect(page.locator('[data-testid="file-picker"]')).not.toBeVisible();
  });

  test('typing in the search box flat-filters the whole tree', async ({ page }) => {
    await gotoHomeWithVault(page);
    const picker = await openPicker(page);

    const search = page.locator('[data-testid="file-picker-search"]');
    await search.fill('song');

    // A deeply nested file surfaces regardless of the current folder.
    await expect(item(page, 'song.txt')).toBeVisible();
    // Breadcrumb hides while searching.
    await expect(page.locator('[data-testid="file-picker-breadcrumb"]')).not.toBeVisible();
    void picker;
  });
});
