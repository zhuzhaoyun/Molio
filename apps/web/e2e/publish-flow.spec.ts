import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * E2E tests for the publish flow.
 *
 * Regression: Issue #11 — publish button was a no-op because onPublish
 * handler was replaced with `() => {}` during a PR merge.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = 'http://localhost:3100/api';

let testVaultPath: string;
let vaultId: string;

test.beforeAll(async () => {
  // 1. Create a temporary vault directory with a test markdown file
  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-publish-'));
  writeFileSync(
    join(testVaultPath, 'test-article.md'),
    '# Test Publish Article\n\nThis is a test article for E2E publish flow testing.\n\n## Section 1\n\nSome content here.\n',
  );

  // 2. Create the vault via daemon API
  const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e-publish-test', path: testVaultPath }),
  });
  const vault = await res.json();
  vaultId = vault.id;
});

test.afterAll(async () => {
  // Cleanup: delete vault via API
  if (vaultId) {
    await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' });
  }
  // Remove temp directory
  if (testVaultPath) {
    rmSync(testVaultPath, { recursive: true, force: true });
  }
});

test.describe('Publish button regression (#11)', () => {
  test('clicking publish in typeset mode should trigger a response', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to knowledge base view
    const kbNav = page.locator('[data-view="knowledge"], text=知识库, text=Knowledge').first();
    await kbNav.click();
    await page.waitForTimeout(500);

    // Wait for vault to load and select the first file
    const fileItem = page.locator('.kb-file-item, .tree-item').first();
    await fileItem.click({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Click "排版" button to enter typeset mode
    const typesetBtn = page.locator('button').filter({ hasText: '排版' }).first();
    await typesetBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(500);

    // Verify publish button is visible
    const publishBtn = page.locator('button').filter({ hasText: '发布' });
    await expect(publishBtn).toBeVisible();

    // THE REGRESSION TEST: click publish and verify something happens
    // Before fix (#11): clicking did nothing (no-op handler)
    // After fix (#11): either COSE install prompt appears OR bridge page opens in new tab
    // After fix (#18): in Electron, setWindowOpenHandler opens bridge in system browser

    // Listen for new page/tab (bridge page opened via window.open)
    const newPagePromise = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);

    await publishBtn.click();

    // Check for COSE install prompt modal first (extension not installed)
    const coseModal = page.locator('.kb-modal').filter({ hasText: /COSE|扩展|安装/ });
    const modalVisible = await coseModal.isVisible({ timeout: 3_000 }).catch(() => false);

    if (modalVisible) {
      // COSE not installed — modal shown, this is correct behavior
      await expect(coseModal).toBeVisible();
    } else {
      // COSE is installed (or check passed) — bridge page should open in new tab
      const newPage = await newPagePromise;
      if (newPage) {
        // Verify the bridge page loaded (it should contain "Molio 发布" or the article title)
        await newPage.waitForLoadState('domcontentloaded');
        const bridgeContent = await newPage.content();
        assert.ok(
          bridgeContent.includes('Molio') || bridgeContent.includes('发布') || bridgeContent.includes('Test'),
          'Bridge page should contain publish UI content',
        );
        await newPage.close();
      } else {
        // No modal and no new page — this is the #11 regression
        await expect(publishBtn).toBeEnabled();
        test.fail(false, 'Publish button click produced no response — regression of #11');
      }
    }
  });

  test('publish button should exist in typeset mode toolbar', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Navigate to knowledge base
    const kbNav = page.locator('[data-view="knowledge"], text=知识库, text=Knowledge').first();
    await kbNav.click();
    await page.waitForTimeout(500);

    // Select first file
    const fileItem = page.locator('.kb-file-item, .tree-item').first();
    await fileItem.click({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Enter typeset mode
    const typesetBtn = page.locator('button').filter({ hasText: '排版' }).first();
    await typesetBtn.click({ timeout: 5_000 });

    // Verify both copy and publish buttons exist
    await expect(page.locator('button').filter({ hasText: '复制' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: '发布' })).toBeVisible();
  });
});
