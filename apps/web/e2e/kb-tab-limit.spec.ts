import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P0
 *
 * Tab cap + overflow UI. Regression for: previously tabs grew unbounded
 * with no cap, no overflow affordance, and no scroll-into-view on activate.
 */

let vault: TempVault;

test.describe('KB tab limit', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-limit');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    // 22 files: f01..f22. Limit is 20; 21st/22nd exercise the cap.
    for (let i = 1; i <= 22; i++) {
      const n = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(vault.path, `f${n}.md`), `# F${n}\n`);
    }
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  const openN = async (page: import('@playwright/test').Page, n: number) => {
    for (let i = 1; i <= n; i++) {
      const nn = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `f${nn}.md` }).click();
    }
  };

  test('opening 20 files yields 20 tabs; 21st is blocked with a toast', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'f01.md' })).toBeVisible({ timeout: 10_000 });

    await openN(page, 20);
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });

    const activeBefore = await page.locator('.kb-wtab.is-active').textContent();
    await page.locator('.kb-tree-item').filter({ hasText: 'f21.md' }).click();
    await expect(page.locator('[data-testid="kb-notice"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20);
    // active did not switch
    await expect(page.locator('.kb-wtab.is-active')).toContainText(String(activeBefore));
  });

  test('at limit, re-opening an already-open file activates without toast', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openN(page, 20);
    await expect(page.locator('.kb-wtab')).toHaveCount(20);

    // f01 is already open → click activates it, no toast, no new tab.
    await page.locator('.kb-tree-item').filter({ hasText: 'f01.md' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(20);
    await expect(page.locator('.kb-wtab.is-active')).toContainText('f01.md');
    await expect(page.locator('[data-testid="kb-notice"]')).toHaveCount(0);
  });

  test('at limit with unsaved edits, opening a new file does NOT prompt to discard', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openN(page, 20);
    // Enter typeset mode on the 20th (active) file and make an unsaved edit.
    await page.locator('[data-testid="kb-btn-typeset"]').click();
    const textarea = page.locator('.kb-typeset-textarea');
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill('# F20\n\nUNSAVED MARKER');

    // Click f21 (new file at limit) → must NOT show discard overlay.
    await page.locator('.kb-tree-item').filter({ hasText: 'f21.md' }).click();
    await expect(page.locator('.kb-overlay.show')).toHaveCount(0, { timeout: 1_000 });
    await expect(page.locator('[data-testid="kb-notice"]')).toBeVisible({ timeout: 3_000 });
    // Edits preserved.
    await expect(textarea).toHaveValue(/UNSAVED MARKER/);
  });

  test('closing one tab at limit re-enables opening a new one', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await openN(page, 20);
    await expect(page.locator('.kb-wtab')).toHaveCount(20);

    // Close the active tab's × (last one, f20).
    await page.locator('.kb-wtab.is-active .kb-wtab-close').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(19, { timeout: 5_000 });

    // Now f21 can be opened.
    await page.locator('.kb-tree-item').filter({ hasText: 'f21.md' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('f21.md');
  });

  test('persisted tabs beyond MAX_TABS are not silently closed on load', async ({ page }) => {
    // Seed 25 persisted tabs pointing at f01..f25 paths (paths need not exist).
    const seeded = Array.from({ length: 25 }, (_, i) => {
      const n = String(i + 1).padStart(2, '0');
      return { id: `file:f${n}.md`, type: 'file', title: `f${n}.md` };
    });
    await page.addInitScript((tabs) => {
      localStorage.setItem('molio.kb.tabs', JSON.stringify(tabs));
      localStorage.setItem('molio.kb.activeTabId', 'file:f01.md');
    }, seeded);

    // 26th new file must be blocked (f22..f25 are already persisted, so use f26).
    fs.writeFileSync(path.join(vault.path, 'f26.md'), '# F26\n');

    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(25, { timeout: 5_000 });

    await page.locator('.kb-tree-item').filter({ hasText: 'f26.md' }).click();
    await expect(page.locator('[data-testid="kb-notice"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(25);
  });
});

test.describe('KB tab overflow UI', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 800, height: 600 } });

  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-overflow');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(vault.path, `g${n}.md`), `# G${n}\n`);
    }
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('active tab scrolls into the visible scroll area on open', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'g01.md' })).toBeVisible({ timeout: 10_000 });

    // Open 8 tabs in a narrow 800px viewport → overflow. The last opened is active.
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `g${n}.md` }).click();
    }
    await expect(page.locator('.kb-wtab')).toHaveCount(8, { timeout: 5_000 });

    const scroll = page.locator('.kb-wtab-scroll');
    const active = page.locator('.kb-wtab.is-active');
    const sBox = await scroll.boundingBox();
    const aBox = await active.boundingBox();
    expect(sBox).not.toBeNull();
    expect(aBox).not.toBeNull();
    // With inline: 'nearest' the active tab is fully within the scroll
    // container (allowing 1px tolerance on each edge), proving it was
    // scrolled into view.
    expect(aBox!.x + aBox!.width).toBeLessThanOrEqual(sBox!.x + sBox!.width + 1);
    expect(aBox!.x).toBeGreaterThanOrEqual(sBox!.x - 1);
  });

  test('arrows appear when tabs overflow and scroll on click', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `g${n}.md` }).click();
    }
    const scroll = page.locator('.kb-wtab-scroll');

    // Overflowing → right arrow visible. Because the active (last) tab was
    // scrolled into view, the container has already shifted right, so the
    // left arrow is also visible.
    await expect(page.locator('[data-testid="kb-tab-arrow-right"]')).toBeVisible();
    await expect(page.locator('[data-testid="kb-tab-arrow-left"]')).toBeVisible();

    const scrollBeforeLeft = await scroll.evaluate((el) => el.scrollLeft);
    await page.locator('[data-testid="kb-tab-arrow-left"]').click();
    await expect.poll(async () => (await scroll.evaluate((el) => el.scrollLeft)) < scrollBeforeLeft - 10).toBeTruthy();
    const scrollBefore = await scroll.evaluate((el) => el.scrollLeft);
    await page.locator('[data-testid="kb-tab-arrow-right"]').click();
    await expect.poll(async () => (await scroll.evaluate((el) => el.scrollLeft)) > scrollBefore + 10).toBeTruthy();
    // Right-arrow click advanced scrollLeft; left arrow remains visible.
    await expect(page.locator('[data-testid="kb-tab-arrow-left"]')).toBeVisible();
  });

  test('dropdown lists all tabs; selecting one activates + scrolls it into view', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `g${n}.md` }).click();
    }
    // g01 is the first-opened, off-screen left after scrolling to g08.
    await page.locator('[data-testid="kb-tab-more"]').click();
    const dropdown = page.locator('[data-testid="kb-tab-dropdown"]');
    await expect(dropdown).toBeVisible({ timeout: 3_000 });
    await expect(dropdown.locator('[data-testid="kb-tab-dropdown-item"]')).toHaveCount(8);

    // Click the item whose title is g01.md → activates g01 and brings it into view.
    await dropdown.locator('[data-testid="kb-tab-dropdown-item"]').first().click();
    await expect(page.locator('.kb-wtab.is-active')).toContainText('g01.md');
    const scroll = page.locator('.kb-wtab-scroll');
    const sBox = await scroll.boundingBox();
    const aBox = await page.locator('.kb-wtab.is-active').boundingBox();
    expect(aBox!.x).toBeGreaterThanOrEqual(sBox!.x - 1);
  });

  test('dropdown item × closes that tab without activating it', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    for (let i = 1; i <= 8; i++) {
      const n = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `g${n}.md` }).click();
    }
    // Active is g08 before opening dropdown.
    await page.locator('[data-testid="kb-tab-more"]').click();
    const dropdown = page.locator('[data-testid="kb-tab-dropdown"]');
    await expect(dropdown).toBeVisible({ timeout: 3_000 });

    // Close the first item (g01) via its ×; active must stay on g08, count 7.
    await dropdown.locator('[data-testid="kb-tab-dropdown-item"]').first()
      .locator('.kb-wtab-dropdown-close').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(7, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('g08.md');
  });
});
