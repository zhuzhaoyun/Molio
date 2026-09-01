import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P0
 *
 * Tab cap + overflow UI (load-in-current-tab model).
 *
 * The cap (MAX_TABS=20) now guards only EXPLICIT new-tab creation ("+",
 * tree right-click「在新标签页中打开」, or a new tab when the active tab is
 * pinned/special). Clicking a plain document recycles the current tab, so it
 * never grows the count and never trips the cap. Seeding localStorage keeps
 * these tests fast instead of clicking 20 files.
 *
 * Regression for: previously tabs grew unbounded with no cap; then every doc
 * click appended a tab up to the cap. Now only explicit creation hits it.
 */

let vault: TempVault;

function makeTabs(n: number, pinned?: number): { id: string; type: string; title: string; pinned?: boolean }[] {
  return Array.from({ length: n }, (_, i) => {
    const num = String(i + 1).padStart(2, '0');
    const t: { id: string; type: string; title: string; pinned?: boolean } = {
      id: `file:f${num}.md`,
      type: 'file',
      title: `f${num}.md`,
    };
    if (pinned != null && i + 1 === pinned) t.pinned = true;
    return t;
  });
}

const seed = async (page: import('@playwright/test').Page, tabs: unknown[], activeId: string, vaultId: string) => {
  await page.addInitScript(({ tabs, activeId, vaultId }: { tabs: unknown[]; activeId: string; vaultId: string }) => {
    localStorage.setItem(`molio.kb.tabs.${vaultId}`, JSON.stringify(tabs));
    localStorage.setItem(`molio.kb.activeTabId.${vaultId}`, activeId);
  }, { tabs, activeId, vaultId });
};

test.describe('KB tab limit', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-tab-limit');
    fs.unlinkSync(path.join(vault.path, 'test.md'));
    // 22 files: f01..f22. Limit is 20; 21st/22nd exercise the cap/recycle.
    for (let i = 1; i <= 26; i++) {
      const n = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(vault.path, `f${n}.md`), `# F${n}\n`);
    }
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });

  test('at cap, "+" is blocked with a toast', async ({ page }) => {
    await seed(page, makeTabs(20), 'file:f20.md', vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });

    await page.locator('[data-testid="kb-tab-add"]').click();
    await expect(page.locator('[data-testid="kb-notice"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20);
  });

  test('at cap, clicking a new doc reuses the current tab (no toast)', async ({ page }) => {
    await seed(page, makeTabs(20), 'file:f20.md', vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });

    // Active is the unpinned file tab f20 → clicking f21 recycles it, no growth.
    await page.locator('.kb-tree-item').filter({ hasText: 'f21.md' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('f21.md');
    await expect(page.locator('[data-testid="kb-notice"]')).toHaveCount(0);
  });

  test('at cap with a pinned active tab, opening a new doc is blocked', async ({ page }) => {
    await seed(page, makeTabs(20, 20), 'file:f20.md', vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-pinned')).toHaveCount(1, { timeout: 3_000 });

    // f20 is pinned → cannot recycle; opening f21 would grow → cap blocks it.
    await page.locator('.kb-tree-item').filter({ hasText: 'f21.md' }).click();
    await expect(page.locator('[data-testid="kb-notice"]')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20);
    await expect(page.locator('.kb-wtab.is-active')).toContainText('f20.md');
  });

  test('closing one tab at cap re-enables "+"', async ({ page }) => {
    await seed(page, makeTabs(20), 'file:f20.md', vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });

    // Close the active (f20) tab.
    await page.locator('.kb-wtab.is-active .kb-wtab-close').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(19, { timeout: 5_000 });

    await page.locator('[data-testid="kb-tab-add"]').click();
    await expect(page.locator('.kb-wtab')).toHaveCount(20, { timeout: 5_000 });
  });

  test('persisted tabs beyond MAX_TABS are not silently closed on load', async ({ page }) => {
    // Seed 25 persisted tabs pointing at f01..f25 (paths need exist).
    await seed(page, makeTabs(25), 'file:f01.md', vault.id);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-wtab')).toHaveCount(25, { timeout: 5_000 });

    // f26 exists; active f01 is an unpinned file tab → clicking f26 recycles it.
    await page.locator('.kb-tree-item').filter({ hasText: 'f26.md' }).click();
    await expect(page.locator('.kb-wtab')).toHaveCount(25, { timeout: 5_000 });
    await expect(page.locator('.kb-wtab.is-active')).toContainText('f26.md');
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

  // To open N file tabs under the load-in-current model, click the first file
  // then for each subsequent file click "+" (new blank) then the file (fills it).
  const openMany = async (page: import('@playwright/test').Page, n: number) => {
    const clickFile = async (i: number) => {
      const num = String(i).padStart(2, '0');
      await page.locator('.kb-tree-item').filter({ hasText: `g${num}.md` }).click();
    };
    await clickFile(1);
    await expect(page.locator('.kb-wtab')).toHaveCount(1, { timeout: 5_000 });
    for (let i = 2; i <= n; i++) {
      await page.locator('[data-testid="kb-tab-add"]').click();
      await clickFile(i);
      await expect(page.locator('.kb-wtab')).toHaveCount(i, { timeout: 5_000 });
    }
  };

  test('active tab scrolls into the visible scroll area on open', async ({ page }) => {
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.kb-tree-item').filter({ hasText: 'g01.md' })).toBeVisible({ timeout: 10_000 });

    await openMany(page, 8);
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
    await openMany(page, 8);
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
    await openMany(page, 8);
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
    await openMany(page, 8);
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
