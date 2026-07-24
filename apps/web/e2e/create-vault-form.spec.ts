import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area kb
 * @priority P0
 *
 * E2E tests for the Create Vault form.
 *
 * Regression: the "浏览" (Browse) button had no onClick handler, so clicking
 * it did nothing. The "创建" (Create) button stayed disabled because users
 * couldn't fill the path field without a working directory picker.
 *
 * In browser mode (no Electron), the Browse button must be hidden and users
 * must type the path manually. In Electron mode, Browse must open a native
 * directory picker dialog.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = 'http://localhost:3100/api';

async function navigateToCreateForm(page: import('@playwright/test').Page) {
  await gotoHome(page);
  await clickNav(page, 'knowledge');

  // Wait for the knowledge base shell to render
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  // Open the vault manager modal by clicking the vault bar in the file panel
  const vaultBar = page.locator('.kb-vault-bar').first();
  await vaultBar.click({ timeout: 5_000 });
  await page.waitForTimeout(300);

  // Click the "创建" action button in the VaultActionPanel to open the create form
  const createAction = page.locator('.vm-action-btn-primary').filter({ hasText: '创建' });
  await createAction.click({ timeout: 5_000 });
  await page.waitForTimeout(300);

  // Verify the create form is visible
  await expect(page.locator('.vm-create-form')).toBeVisible();
}

test.describe('Create vault form', () => {
  test('browse button should always be visible; shows alert in browser mode', async ({ page }) => {
    await navigateToCreateForm(page);

    // Browse button must always be visible (even without Electron)
    const browseBtn = page.locator('.vm-browse-btn');
    await expect(browseBtn).toBeVisible();

    // In browser mode (no Electron), clicking Browse shows an informational alert.
    // Use page.on('dialog') instead of waitForEvent to avoid a race condition
    // where alert() blocks the page and prevents click() from returning.
    const dialogPromise = new Promise<string>((resolve) => {
      const handler = (dialog: import('@playwright/test').Dialog) => {
        resolve(dialog.message());
        dialog.accept();
        page.off('dialog', handler);
      };
      page.on('dialog', handler);
    });

    await browseBtn.click();

    const message = await dialogPromise;
    expect(message).toContain('桌面客户端');
  });

  test('shows container-path hint in browser (non-Electron) mode', async ({ page }) => {
    await navigateToCreateForm(page);

    // Without a native folder picker (browser / Docker / NAS), the form must
    // guide users to the container-internal mount path so they don't type the
    // NAS host path and silently write into the ephemeral container layer.
    const hint = page.locator('.vm-form-hint');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('/vaults');
  });

  test('create button should be disabled when path is empty, enabled when path is filled', async ({ page }) => {
    await navigateToCreateForm(page);

    const submitBtn = page.locator('.vm-submit-btn').filter({ hasText: /创建/ });
    await expect(submitBtn).toBeVisible();

    // Path empty → disabled (regardless of name)
    await expect(submitBtn).toBeDisabled();

    const nameInput = page.locator('.vm-form-input').first();
    await nameInput.fill('test-vault');
    await expect(submitBtn).toBeDisabled(); // still disabled without path

    // Path filled, name empty → enabled (name auto-derives from path)
    await nameInput.fill('');
    const pathInput = page.locator('.vm-form-input').nth(1);
    await pathInput.fill('/tmp/test-vault');
    await expect(submitBtn).toBeEnabled();
  });

  test('create button should be enabled when both name and path are filled', async ({ page }) => {
    await navigateToCreateForm(page);

    const nameInput = page.locator('.vm-form-input').first();
    const pathInput = page.locator('.vm-form-input').nth(1);
    const submitBtn = page.locator('.vm-submit-btn').filter({ hasText: /创建/ });

    await nameInput.fill('e2e-test-vault');
    await pathInput.fill('/tmp/e2e-test-vault-nonexistent');

    await expect(submitBtn).toBeEnabled();
  });

  test('creating with empty name should derive name from path', async ({ page }) => {
    const testVaultPath = `/tmp/e2e-derive-name-${Date.now()}`;

    await navigateToCreateForm(page);

    const pathInput = page.locator('.vm-form-input').nth(1);
    const submitBtn = page.locator('.vm-submit-btn').filter({ hasText: /创建/ });

    // Leave name empty, only fill path
    await pathInput.fill(testVaultPath);
    await expect(submitBtn).toBeEnabled();

    const apiRequest = page.waitForRequest(
      (req) => req.url().includes('/knowledge/vaults') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    await submitBtn.click();

    const req = await apiRequest;
    const body = req.postDataJSON();
    // Name should be auto-derived from the last path segment
    const expectedName = testVaultPath.split('/').pop();
    expect(body.name).toBe(expectedName);
    expect(body.path).toBe(testVaultPath);

    // Cleanup
    const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await listRes.json();
    const created = vaults.find((v: { path: string }) => v.path === testVaultPath);
    if (created) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${created.id}`, { method: 'DELETE' });
    }
  });

  test('submitting the form should call the daemon API and create a vault', async ({ page }) => {
    const testVaultName = 'e2e-create-test-' + Date.now();
    const testVaultPath = `/tmp/${testVaultName}`;

    await navigateToCreateForm(page);

    const nameInput = page.locator('.vm-form-input').first();
    const pathInput = page.locator('.vm-form-input').nth(1);
    const submitBtn = page.locator('.vm-submit-btn').filter({ hasText: /创建/ });

    await nameInput.fill(testVaultName);
    await pathInput.fill(testVaultPath);
    await expect(submitBtn).toBeEnabled();

    // Listen for the API request
    const apiRequest = page.waitForRequest(
      (req) => req.url().includes('/knowledge/vaults') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    await submitBtn.click();

    // Verify the API was called
    const req = await apiRequest;
    const body = req.postDataJSON();
    expect(body.name).toBe(testVaultName);
    expect(body.path).toBe(testVaultPath);

    // Wait for the form to disappear (view switches back to list)
    await expect(page.locator('.vm-create-form')).toBeHidden({ timeout: 10_000 });

    // Cleanup: delete the vault we just created
    const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await listRes.json();
    const created = vaults.find((v: { name: string }) => v.name === testVaultName);
    if (created) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${created.id}`, { method: 'DELETE' });
    }
  });

  test('Enter key should submit when both fields are filled', async ({ page }) => {
    const testVaultName = 'e2e-enter-test-' + Date.now();
    const testVaultPath = `/tmp/${testVaultName}`;

    await navigateToCreateForm(page);

    const nameInput = page.locator('.vm-form-input').first();
    const pathInput = page.locator('.vm-form-input').nth(1);

    await nameInput.fill(testVaultName);
    await pathInput.fill(testVaultPath);

    // Listen for the API call
    const apiRequest = page.waitForRequest(
      (req) => req.url().includes('/knowledge/vaults') && req.method() === 'POST',
      { timeout: 10_000 },
    );

    // Press Enter on the path input
    await pathInput.press('Enter');

    // Verify the API was called
    const req = await apiRequest;
    const body = req.postDataJSON();
    expect(body.name).toBe(testVaultName);

    // Cleanup
    const listRes = await fetch(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await listRes.json();
    const created = vaults.find((v: { name: string }) => v.name === testVaultName);
    if (created) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${created.id}`, { method: 'DELETE' });
    }
  });
});
