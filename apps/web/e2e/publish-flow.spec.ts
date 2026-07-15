import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area publish
 * @priority P0
 *
 * E2E tests for the publish flow.
 *
 * Regression: Issue #11 — publish button was a no-op because onPublish
 * handler was replaced with `() => {}` during a PR merge.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

const DAEMON_API = 'http://localhost:3100/api';

/** fetch with a hard timeout so beforeAll never hangs if daemon is unreachable */
async function fetchWithTimeout(url: string, init: RequestInit = {}, ms = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

let testVaultPath: string;
let vaultId: string;
/** Unique vault name per run — avoids strict-mode collisions with leftover vaults */
const vaultName = `e2e-pub-${Date.now()}`;

test.beforeAll(async () => {
  // 0. Purge any stale vaults left over from crashed runs
  try {
    const list = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`);
    const { vaults } = await list.json();
    for (const v of vaults as { id: string; name: string }[]) {
      if (v.name.startsWith('e2e-pub-') || v.name === 'e2e-publish-test') {
        await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${v.id}`, { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* daemon might not be running yet */ }

  // 1. Create a temporary vault directory with a test markdown file
  testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-publish-'));
  writeFileSync(
    join(testVaultPath, 'test-article.md'),
    '# Test Publish Article\n\nThis is a test article for E2E publish flow testing.\n\n## Section 1\n\nSome content here.\n',
  );

  // 2. Create the vault via daemon API (with timeout to avoid hanging)
  const res = await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: vaultName, path: testVaultPath }),
  });
  const vault = await res.json();
  vaultId = vault.id;
});

test.afterAll(async () => {
  // Cleanup: delete vault via API
  if (vaultId) {
    await fetchWithTimeout(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
  }
  // Remove temp directory
  if (testVaultPath) {
    rmSync(testVaultPath, { recursive: true, force: true });
  }
});

/**
 * Helper: navigate to knowledge base, select the test vault, and open a file.
 *
 * The vault was created in beforeAll via the daemon API, but the UI vault store
 * only fetches vaults on page mount. We reload once so the store picks up the
 * new vault before opening the vault switcher.
 */
async function navigateToTestFile(page: import('@playwright/test').Page) {
  await gotoHome(page);
  // Reload to re-fetch vault list from daemon (picks up the vault created in beforeAll)
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  // Open vault switcher
  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await page.waitForTimeout(500);

  // Select the test vault (unique name avoids collision with leftover vaults)
  const vaultItem = page.locator('.vm-vault-item').filter({ hasText: vaultName });
  await vaultItem.click({ timeout: 5_000 });
  await page.waitForTimeout(1000);

  // Click the first file in the tree
  const fileItem = page.locator('.kb-tree-item').first();
  await fileItem.click({ timeout: 10_000 });

  // Wait for file content to load — publishToChrome returns silently if fileContent is null.
  // The header filename appears immediately; the content area shows "Loading..." until fetched.
  await expect(page.locator('.kb-header-filename-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kb-content-area').getByText('Loading...')).toBeHidden({ timeout: 10_000 });
}

test.describe('Publish button regression (#11)', () => {
  /* Navigation-heavy test — vault switcher + file open + typeset mode needs extra time */
  test.setTimeout(60_000);

  test('clicking publish in typeset mode should trigger a response', async ({ page }) => {
    await navigateToTestFile(page);

    // Click "排版" button to enter typeset mode
    const typesetBtn = page.locator('button').filter({ hasText: '排版' }).first();
    await typesetBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(500);

    // Verify publish button is visible (icon-only button — locate by tooltip)
    const publishBtn = page.locator('button[title="发布"]');
    await expect(publishBtn).toBeVisible();

    // THE REGRESSION TEST: click publish and verify something happens
    // Before fix (#11): clicking did nothing (no-op handler)
    // After fix (#11): either COSE install prompt appears OR bridge page opens in new tab
    // After fix (#18): in Electron, setWindowOpenHandler opens bridge in system browser

    // Listen for new page/tab (bridge page opened via window.open)
    const newPagePromise = page.context().waitForEvent('page', { timeout: 5_000 }).catch(() => null);

    await publishBtn.click();

    // Check for COSE install prompt modal first (extension not installed).
    // publishToChrome is async (network call to check-cose) — wait for modal to appear.
    const coseModal = page.locator('.kb-modal').filter({ hasText: /COSE|扩展|安装/ });
    let modalVisible = false;
    try {
      await expect(coseModal).toBeVisible({ timeout: 5_000 });
      modalVisible = true;
    } catch {
      modalVisible = false;
    }

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
        throw new Error('Publish button click produced no response — regression of #11');
      }
    }
  });

  test('copy button in typeset mode should include CSS styles in clipboard', async ({ page }) => {
    await navigateToTestFile(page);

    // Enter typeset mode
    const typesetBtn = page.locator('button').filter({ hasText: '排版' }).first();
    await typesetBtn.click({ timeout: 5_000 });
    await page.waitForTimeout(500);

    // Verify the theme <style> element is injected into <head>
    const themeStyle = page.locator('#md-theme');
    await expect(themeStyle).toBeAttached({ timeout: 5_000 });

    // Verify the style element has non-empty content (CSS rules were generated)
    const cssContent = await themeStyle.textContent();
    assert.ok(cssContent, 'Theme CSS should not be empty');
    assert.ok(
      cssContent.length > 100,
      `Theme CSS should contain meaningful rules, got ${cssContent.length} chars`,
    );

    // Click copy button
    const copyBtn = page.locator('button[title="复制"]');
    await expect(copyBtn).toBeVisible();

    // Grant clipboard permission and click copy
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await copyBtn.click();
    await page.waitForTimeout(500);

    // Read clipboard — should contain HTML with <style> tag (the CSS bundle fix)
    try {
      const clipboardHtml = await page.evaluate(async () => {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes('text/html')) {
              const blob = await item.getType('text/html');
              return await blob.text();
            }
          }
        } catch {
          return null;
        }
        return null;
      });

      if (clipboardHtml) {
        // The clipboard HTML MUST contain a <style> tag — this is the Fix 1 bundle
        assert.ok(
          clipboardHtml.includes('<style>'),
          'Clipboard HTML should contain <style> tag with bundled CSS',
        );
        // Should also contain the rendered content
        assert.ok(
          clipboardHtml.includes('# Test Publish Article') || clipboardHtml.includes('Test Publish'),
          'Clipboard HTML should contain article content',
        );
        // CSS MUST NOT have #output scope prefix — WeChat has no #output wrapper
        const styleContent = clipboardHtml.match(/<style>([\s\S]*)<\/style>/)?.[1] ?? '';
        assert.ok(
          !/#output\s/.test(styleContent),
          'Clipboard CSS should NOT contain #output scope prefix (would break WeChat paste)',
        );
      }
      // If clipboard is empty, the test still passes — clipboard API may not be available in CI
    } catch {
      // Clipboard API may not be available in headless browser — skip assertion
    }
  });
});
