import { test, expect } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area kb
 * @priority P1
 *
 * Regression (2026-09): 「打开本地仓库」 silently did nothing when the daemon
 * rejected the path (e.g. a dot-directory like `.claude`). Both entry points
 * swallowed the error:
 *   - Electron: the picker's cancel-handling catch also wrapped the `onOpen`
 *     call, so a 400 was reported as "user cancelled";
 *   - browser: `OpenVaultForm.handleSubmit` awaited `onOpen` with no catch →
 *     unhandled rejection, no UI.
 * Meanwhile 「创建仓库」 showed a message all along (CreateVaultForm catches),
 * which is why only the open path looked broken.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = `http://localhost:${process.env.MOLIO_E2E_DAEMON_PORT ?? '3100'}/api`;

/** Open the vault manager and switch to the 「打开本地仓库」 form. */
async function openOpenForm(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await expect(page.locator('.vm-list')).toBeVisible({ timeout: 5_000 });
  // The non-primary action button in the right panel is 「打开」.
  await page.locator('.vm-action-btn').filter({ hasText: '打开' }).click();
  await expect(page.locator('.vm-submit-btn')).toBeVisible({ timeout: 5_000 });
}

async function submitOpenPath(page: import('@playwright/test').Page, vaultPath: string) {
  await page.locator('.vm-form-input').first().fill(vaultPath);
  await page.locator('.vm-submit-btn').click();
}

test.describe('open local vault — error feedback', () => {
  test('opening a dot-directory shows an error instead of failing silently', async ({ page }) => {
    const base = `/tmp/e2e-open-dot-${Date.now()}`;
    const dotPath = `${base}/.claude`;
    mkdirSync(dotPath, { recursive: true });

    try {
      await openOpenForm(page);
      await submitOpenPath(page, dotPath);

      // The daemon's rejection must surface, not vanish.
      const dialog = page.locator('[data-testid="confirm-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText('内部目录');
      // Informational dialog: exactly one dismiss action (no redundant 取消).
      await expect(dialog.locator('.kb-modal-footer .kb-btn')).toHaveCount(1);
      await expect(dialog.locator('.kb-btn-ghost')).toHaveCount(0);
      // And the form must stay put so the path can be corrected.
      await expect(page.locator('.vm-submit-btn')).toBeVisible();

      // Dismissing clears the dialog.
      await dialog.locator('.kb-btn').click();
      await expect(dialog).toBeHidden();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('opening a path nested inside an existing vault shows an error', async ({ page }) => {
    const base = `/tmp/e2e-open-nested-${Date.now()}`;
    const parent = `${base}/vault`;
    mkdirSync(parent, { recursive: true });
    const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'e2e-nested-parent', path: parent }),
    });
    const parentVault = await res.json();

    try {
      await openOpenForm(page);
      await submitOpenPath(page, `${parent}/child`);

      const dialog = page.locator('[data-testid="confirm-dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(dialog).toContainText('嵌套');
    } finally {
      await fetch(`${DAEMON_API}/knowledge/vaults/${parentVault.id}`, { method: 'DELETE' });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('opening a valid folder still works (no false error)', async ({ page }) => {
    const base = `/tmp/e2e-open-ok-${Date.now()}`;
    mkdirSync(base, { recursive: true });

    try {
      await openOpenForm(page);
      await submitOpenPath(page, base);

      // Form closes, vault appears in the list, and no error dialog was shown.
      await expect(page.locator('.vm-submit-btn')).toBeHidden({ timeout: 10_000 });
      await expect(page.locator('.vm-vault-item').filter({ hasText: base.split('/').pop()! })).toBeVisible();
      await expect(page.locator('[data-testid="confirm-dialog"]')).toBeHidden();
    } finally {
      const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
      const { vaults } = await listRes.json();
      const created = vaults.find((v: { path: string }) => v.path === base);
      if (created) await fetch(`${DAEMON_API}/knowledge/vaults/${created.id}`, { method: 'DELETE' });
      rmSync(base, { recursive: true, force: true });
    }
  });
});
