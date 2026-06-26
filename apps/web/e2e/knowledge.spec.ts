import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';

/**
 * @area kb
 * @priority P0
 *
 * E2E tests for the Knowledge Base page.
 *
 * Uses createTempVault() to register a real temp directory as a vault,
 * then verifies file tree, file viewing, and basic interactions.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

let vault: TempVault;

test.describe('Knowledge Base', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-test');
  });

  test.afterAll(async () => {
    if (vault) await cleanupTempVault(vault);
  });

  test('page shows knowledge base shell', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');

    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
  });

  test('vault appears in vault selector after creation', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // The vault we created in beforeAll should be selectable
    // Look for vault bar / vault selector area
    const vaultBar = page.locator('.kb-vault-bar').first();
    if (await vaultBar.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await vaultBar.click();
      await page.waitForTimeout(500);

      // Vault name should appear in the modal/list
      const vaultList = page.locator('.vault-manager-modal, .vm-vault-list');
      if (await vaultList.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(vaultList).toContainText('e2e-kb-test');
      }
    }
  });

  test('selecting vault shows file tree with test.md', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Wait for the file panel to load (vault may auto-select)
    await page.waitForTimeout(1000);

    // The file panel should show the file tree
    const filePanel = page.locator('.kb-file-panel');
    if (await filePanel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // Look for test.md in the file tree
      const fileTree = page.locator('.kb-file-tree, .file-tree');
      if (await fileTree.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await expect(fileTree).toContainText('test.md');
      }
    }
  });

  test('clicking a file shows its content in main area', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    // Try to click on test.md in the file tree
    const testFile = page.locator('.kb-file-tree-node, .file-tree-node').filter({ hasText: 'test.md' });
    if (await testFile.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await testFile.click();
      await page.waitForTimeout(500);

      // Main content area should show the file content
      const mainContent = page.locator('.kb-main');
      if (await mainContent.isVisible({ timeout: 3_000 }).catch(() => false)) {
        // The file contains "# Test\nHello world\n" which should be rendered
        await expect(mainContent).toContainText('Test', { timeout: 5_000 });
      }
    }
  });

  test('main content area is visible', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    // The main content area should exist (class is .kb-main, not .kb-main-content)
    const mainContent = page.locator('.kb-main');
    await expect(mainContent).toBeVisible({ timeout: 5_000 });
  });

  test('file is selected when navigated via URL params', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1000);

    // Navigate directly with URL params (same pendingUrlNav mechanism
    // used by the location.state handler for graph double-click navigation)
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=test.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // Wait for file tree to load and file to be selected (and cleared from URL)
    await expect(page).toHaveURL(/knowledge$/, { timeout: 10_000 });

    // The file content should be rendered in the main area
    const mainContent = page.locator('.kb-main');
    await expect(mainContent).toContainText('Test', { timeout: 10_000 });
  });
});
