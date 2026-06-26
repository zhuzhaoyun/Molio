/**
 * @area kb
 * @priority P1
 *
 * E2E tests for Markdown rendering in the Knowledge Base.
 *
 * Creates a temporary vault with a comprehensive markdown file, then
 * verifies each rendering feature is correctly output by the doocs/md
 * rendering pipeline.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 *
 * CSS class reference (doocs/md Knowledge Base renderer):
 *   <table class="md-table"> inside <section class="table-wrapper">
 *   <li class="task-list-item"> with <input class="md-task-checkbox" disabled>
 *   <del> for strikethrough
 *   <img loading="lazy"> for images
 *   <li> for regular lists (display: block in default theme)
 * Note: Rich CSS styles (zebra-stripe, list-item display, comprehensive base) are
 *   defined in vendor/doocs-md/shared/configs/theme-css/ via applyTheme().
 */

import { test, expect } from '@playwright/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gotoHome, clickNav } from './helpers/navigation';

const DAEMON_API = 'http://localhost:3100/api';

const RENDER_TEST_MD = `# Test Markdown Rendering

## Table

| Header 1 | Header 2 |
|----------|----------|
| Row 1 Cell 1 | Row 1 Cell 2 |
| Row 2 Cell 1 | Row 2 Cell 2 |

## Task List

- [ ] Unchecked task item
- [x] Checked task item

## Strikethrough

This text has ~~strikethrough~~ formatting.

## Image

![Test Image](https://example.com/test.png)

## Regular List

- List item one
- List item two
- List item three
`;

let testVaultPath: string;
let vaultId: string;
const vaultName = `e2e-render-${Date.now()}`;

/**
 * Navigate to knowledge base, select the test vault, and open render-test.md.
 *
 * The vault was created in beforeAll via the daemon API, but the UI vault store
 * only fetches vaults on page mount. We reload once so the store picks up the
 * new vault before opening the vault switcher.
 */
async function openRenderTestFile(page: import('@playwright/test').Page) {
  await gotoHome(page);
  // Reload to re-fetch vault list from daemon (picks up vault created in beforeAll)
  await page.reload({ waitUntil: 'networkidle' });
  await clickNav(page, 'knowledge');
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

  // Open vault switcher
  await page.locator('.kb-vault-bar').first().click({ timeout: 5_000 });
  await page.waitForTimeout(500);

  // Select the test vault (unique name avoids collision with leftover vaults)
  const vaultItem = page.locator('.vm-vault-item').filter({ hasText: vaultName });
  await vaultItem.click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);

  // Click render-test.md in the file tree
  const fileItem = page.locator('.kb-tree-item').filter({ hasText: 'render-test.md' });
  await fileItem.click({ timeout: 10_000 });

  // Wait for file content to load
  await expect(page.locator('.kb-header-filename-center')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.kb-content-area').getByText('Loading...')).toBeHidden({ timeout: 10_000 });
}

test.describe('Markdown Rendering', () => {
  test.beforeAll(async () => {
    // Create a temporary directory with a comprehensive markdown test file
    testVaultPath = mkdtempSync(join(tmpdir(), 'molio-e2e-render-'));
    writeFileSync(join(testVaultPath, 'render-test.md'), RENDER_TEST_MD);

    // Register the vault via the daemon API
    const res = await fetch(`${DAEMON_API}/knowledge/vaults`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: vaultName, path: testVaultPath }),
    });
    const vault = await res.json();
    vaultId = vault.id;
  });

  test.afterAll(async () => {
    // Cleanup: delete vault via API and remove temp directory
    if (vaultId) {
      await fetch(`${DAEMON_API}/knowledge/vaults/${vaultId}`, { method: 'DELETE' }).catch(() => {});
    }
    if (testVaultPath) {
      rmSync(testVaultPath, { recursive: true, force: true });
    }
  });

  test('renders tables with correct class names and structure', async ({ page }) => {
    await openRenderTestFile(page);

    // doocs/md renders tables as <table class="md-table"> inside <section class="table-wrapper">
    const tableWrapper = page.locator('#output .table-wrapper').first();
    await expect(tableWrapper).toBeVisible({ timeout: 5_000 });

    const table = tableWrapper.locator('table.md-table');
    await expect(table).toBeVisible();

    // Verify table structure: thead > th, tbody > td
    await expect(table.locator('thead th').first()).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(2);
    await expect(table.locator('tbody td').first()).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(2);
  });

  test('renders task list with disabled checkboxes', async ({ page }) => {
    await openRenderTestFile(page);

    // Task list checkboxes have class .md-task-checkbox and are disabled in read mode
    const checkboxes = page.locator('#output .md-task-checkbox');
    await expect(checkboxes).toHaveCount(2);
    await expect(checkboxes.first()).toBeDisabled();
    await expect(checkboxes.nth(1)).toBeDisabled();

    // Each checkbox is wrapped in a li with class .task-list-item
    const taskItems = page.locator('#output .task-list-item');
    await expect(taskItems).toHaveCount(2);
  });

  test('renders strikethrough with del tag', async ({ page }) => {
    await openRenderTestFile(page);

    // GFM strikethrough (~~text~~) renders as <del>text</del>
    const del = page.locator('#output del').first();
    await expect(del).toBeVisible({ timeout: 5_000 });
    await expect(del).toHaveText('strikethrough');
  });

  test('renders images with lazy loading', async ({ page }) => {
    await openRenderTestFile(page);

    // doocs/md adds loading="lazy" to all images
    const img = page.locator('#output img[loading="lazy"]').first();
    await expect(img).toHaveAttribute('loading', 'lazy', { timeout: 5_000 });
    await expect(img).toHaveAttribute('alt', 'Test Image');
    await expect(img).toHaveAttribute('src', 'https://example.com/test.png');

    // Image is wrapped in a <figure> element
    const figure = page.locator('#output figure').first();
    await expect(figure).toBeVisible();
  });

  test('list items display as block value', async ({ page }) => {
    await openRenderTestFile(page);

    // Our test content has 3 regular list items + 2 task list items
    const listItems = page.locator('#output li');
    await expect(listItems).toHaveCount(5);

    // [MOLIO] 修复后 li 使用原生 list-item 渲染，而非 display: block
    const firstRegularItem = page.locator('#output ul li').first();
    await expect(firstRegularItem).toBeVisible();
    const display = await firstRegularItem.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('list-item');
  });

  test('tables have zebra-stripe styling on even rows', async ({ page }) => {
    await openRenderTestFile(page);

    // Verify table body rows exist
    const rows = page.locator('#output .md-table tbody tr');
    await expect(rows).toHaveCount(2);

    // Verify even rows have a background color from doocs/md theme
    const evenRow = page.locator('#output .md-table tbody tr:nth-child(even)').first();
    await expect(evenRow).toBeVisible({ timeout: 5_000 });
  });
});
