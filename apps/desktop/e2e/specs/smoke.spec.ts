import { test, expect, type Page } from '@playwright/test';
import { launchMolioApp, closeMolioApp, type LaunchedApp } from '../helpers/electron-app';

/**
 * Desktop E2E smoke tests.
 *
 * Verifies that the packaged Electron app (win-unpacked) launches correctly,
 * the daemon becomes healthy, and all main pages render without errors.
 *
 * Prerequisites:
 *   pnpm build && npx electron-builder --win --dir
 *
 * Run:
 *   pnpm test:e2e          (headless)
 *   pnpm test:e2e:headed   (with GUI window)
 */

let app: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  app = await launchMolioApp();
  page = app.page;
});

test.afterAll(async () => {
  if (app) {
    await closeMolioApp(app);
  }
});

test('app launches and daemon becomes healthy', async () => {
  // Window should be visible
  await expect(page.locator('body')).toBeVisible();

  // Daemon health endpoint should respond
  const res = await page.evaluate(async () => {
    const r = await fetch('http://localhost:3100/api/health');
    return r.ok;
  });
  expect(res).toBe(true);
});

test('home page renders with brand or chat interface', async () => {
  // Navigate to home first
  await page.click('[data-tooltip="Home"]');
  await page.waitForSelector('.home-page', { state: 'visible' });

  // Either landing (hero with "Molio") or chat-active (composer)
  const hasLanding = await page.locator('.home-landing').isVisible().catch(() => false);
  const hasChat = await page.locator('.chat-active').isVisible().catch(() => false);

  expect(hasLanding || hasChat).toBe(true);

  if (hasLanding) {
    // Landing shows brand name
    await expect(page.locator('.home-page')).toContainText('Molio');
  } else {
    // Chat mode shows composer
    await expect(page.locator('.composer')).toBeVisible();
  }
});

test('navigates between all main pages', async () => {
  // Home -> Knowledge Base
  await page.click('[data-tooltip="Knowledge Base"]');
  await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 10_000 });

  // Knowledge Base -> Runtimes
  await page.click('[data-tooltip="Runtimes"]');
  await expect(page.locator('.rt-shell')).toBeVisible({ timeout: 10_000 });

  // Runtimes -> Settings
  await page.click('[data-tooltip="Settings"]');
  await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 10_000 });

  // Settings -> Home
  await page.click('[data-tooltip="Home"]');
  await expect(page.locator('.home-page')).toBeVisible({ timeout: 10_000 });
});

test('knowledge base page shows vault bar and content area', async () => {
  await page.click('[data-tooltip="Knowledge Base"]');
  await expect(page.locator('.kb-file-panel')).toBeVisible({ timeout: 10_000 });

  // Vault bar should be present (for selecting/creating vaults)
  await expect(page.locator('.kb-vault-bar')).toBeVisible();

  // Main content area: wait for any of these states to be visible
  const emptyState = page.locator('.kb-empty-state').first();
  const treeItem = page.locator('.kb-tree-item').first();
  const vaultModal = page.locator('.vm-overlay');
  
  // Wait for at least one to be visible (with timeout)
  await Promise.race([
    emptyState.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
    treeItem.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
    vaultModal.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
  ]);
  
  const hasEmpty = await emptyState.isVisible().catch(() => false);
  const hasTree = await treeItem.isVisible().catch(() => false);
  const hasVaultModalVisible = await vaultModal.isVisible().catch(() => false);
  expect(hasEmpty || hasTree || hasVaultModalVisible).toBe(true);
});

test('runtimes page shows agent management interface', async () => {
  await page.click('[data-tooltip="Runtimes"]');
  await expect(page.locator('.rt-shell')).toBeVisible({ timeout: 10_000 });

  // Wait for loading to complete
  await page.locator('.rt-loading').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});

  // Should have the tab interface (Agents / Runs)
  await expect(page.locator('[role="tablist"]')).toBeVisible();

  // Agent cards or empty state should be present
  const hasAgents = await page.locator('.rt-agent-card').first().isVisible().catch(() => false);
  const hasEmptyState = await page.locator('.rt-empty').isVisible().catch(() => false);
  expect(hasAgents || hasEmptyState).toBe(true);
});
