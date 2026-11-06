import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area kb
 * @priority P1
 *
 * E2E tests for the vault-list row menu.
 *
 * Regression (2026-09): the row button used a `⋯` glyph — which everywhere
 * else in this app opens an overflow MENU (see OverflowMenu / MessageToolbar)
 * — but clicking it jumped straight to a delete confirmation. Users looking
 * for "options" got a destructive dialog instead, and the button only
 * appeared on hover so touch devices could not reach it at all.
 *
 * The fix turns `⋯` into a real menu (copy ID / reveal in file manager /
 * remove) with the destructive item at the bottom, red, behind a divider.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

/** Register a vault through the API — cheaper and less flaky than the UI form. */
async function createVault(name: string, vaultPath: string): Promise<string> {
  mkdirSync(vaultPath, { recursive: true });
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, path: vaultPath }),
  });
  const vault = await res.json();
  return vault.id as string;
}

async function deleteVault(id: string): Promise<void> {
  await fetch(`${DAEMON_API}/knowledge/vaults/${id}`, { method: 'DELETE' });
}

/** Open the vault manager modal (left panel = the vault list). */
async function openVaultManager(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await expect(page.locator('.vm-list')).toBeVisible({ timeout: 5_000 });
}

/** Hover a vault row and click its `⋯` trigger. */
async function openRowMenu(page: import('@playwright/test').Page, vaultName: string) {
  const row = page.locator('.vm-vault-item').filter({ hasText: vaultName });
  await row.hover();
  await row.locator('[data-testid="vault-more-btn"]').click();
}

test.describe('vault list row menu', () => {
  test('⋯ opens a menu instead of jumping straight to a delete dialog', async ({ page }) => {
    const name = 'e2e-menu-' + Date.now();
    const vaultPath = `/tmp/${name}`;
    const id = await createVault(name, vaultPath);

    try {
      await openVaultManager(page);
      await openRowMenu(page, name);

      // The core regression: a menu, not a delete confirmation.
      await expect(page.locator('.ctx-menu')).toBeVisible();
      await expect(page.locator('[data-testid="confirm-dialog"]')).toBeHidden();
    } finally {
      await deleteVault(id);
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('menu lists copy-ID and remove; reveal is absent in browser mode', async ({ page }) => {
    const name = 'e2e-menu-items-' + Date.now();
    const vaultPath = `/tmp/${name}`;
    const id = await createVault(name, vaultPath);

    try {
      await openVaultManager(page);
      await openRowMenu(page, name);

      await expect(page.locator('[data-testid="vault-menu-copy-id"]')).toBeVisible();
      // Destructive item is last and dangerous.
      const removeItem = page.locator('[data-testid="vault-menu-remove"]');
      await expect(removeItem).toBeVisible();
      await expect(removeItem).toHaveClass(/is-danger/);

      // Reveal-in-file-manager needs the Electron bridge (window.__electron__),
      // which does not exist in a browser — the item must not be rendered.
      await expect(page.locator('[data-testid="vault-menu-reveal"]')).toHaveCount(0);
    } finally {
      await deleteVault(id);
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('copy vault ID puts the vault id on the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const name = 'e2e-menu-copy-' + Date.now();
    const vaultPath = `/tmp/${name}`;
    const id = await createVault(name, vaultPath);

    try {
      await openVaultManager(page);
      await openRowMenu(page, name);
      await page.locator('[data-testid="vault-menu-copy-id"]').click();

      const clip = await page.evaluate(() => navigator.clipboard.readText());
      expect(clip).toBe(id);
    } finally {
      await deleteVault(id);
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('remove goes through the confirm dialog and leaves files on disk', async ({ page }) => {
    const name = 'e2e-menu-remove-' + Date.now();
    const vaultPath = `/tmp/${name}`;
    const id = await createVault(name, vaultPath);

    try {
      await openVaultManager(page);
      await openRowMenu(page, name);
      await page.locator('[data-testid="vault-menu-remove"]').click();

      // Confirmation still guards the destructive action, with reassuring copy.
      const dialog = page.locator('[data-testid="confirm-dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(name);
      await expect(dialog).toContainText('不会删除本地文件');

      await dialog.locator('.kb-btn-danger').click();

      // Row disappears from the list…
      await expect(page.locator('.vm-vault-item').filter({ hasText: name })).toHaveCount(0, { timeout: 10_000 });
      // …but the folder is untouched (the reassurance above must be true).
      expect(existsSync(vaultPath)).toBe(true);
    } finally {
      await deleteVault(id);
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });

  test('Escape closes the row menu', async ({ page }) => {
    const name = 'e2e-menu-esc-' + Date.now();
    const vaultPath = `/tmp/${name}`;
    const id = await createVault(name, vaultPath);

    try {
      await openVaultManager(page);
      await openRowMenu(page, name);
      await expect(page.locator('.ctx-menu')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect(page.locator('.ctx-menu')).toBeHidden();
    } finally {
      await deleteVault(id);
      rmSync(vaultPath, { recursive: true, force: true });
    }
  });
});
