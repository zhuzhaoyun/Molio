import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

const VAULT_ID = 'b1dba3bd-c36f-4921-b3a7-fea301705863';

test.describe('Graph Settings Panel', () => {
  test.beforeEach(async ({ page }) => {
    // Set vault in localStorage before the app loads so vaultStore picks it up
    await page.addInitScript((id) => {
      localStorage.setItem('molio.activeVaultId', id);
    }, VAULT_ID);
  });

  test('settings button opens and closes panel', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Settings button appears once vault is selected (even before graph data loads)
    const btn = page.locator('.graph-settings-btn');
    await expect(btn).toBeVisible({ timeout: 10_000 });

    // Click to open — panel appears once graph data loads
    await btn.click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Button should have is-active class when panel is open
    await expect(btn).toHaveClass(/is-active/);

    // Click again to close
    await btn.click();
    await expect(panel).not.toBeVisible({ timeout: 3_000 });
  });

  test('tab switching works', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Open settings (wait for graph data to load so panel appears)
    await page.locator('.graph-settings-btn').click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });

    // Click each tab and verify it becomes active
    for (const tab of ['筛选', '外观', '力度', '图例']) {
      await panel.locator('.graph-settings__tab', { hasText: tab }).click();
      await expect(panel.locator('.graph-settings__tab.is-active')).toHaveText(tab);
    }
  });

  test('force sliders exist and are interactive', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // Open settings, switch to forces tab
    await page.locator('.graph-settings-btn').click();
    const panel = page.locator('.graph-settings-panel');
    await expect(panel).toBeVisible({ timeout: 10_000 });
    await panel.locator('.graph-settings__tab', { hasText: '力度' }).click();

    // Verify all 4 force sliders exist
    const sliders = panel.locator('.graph-settings__range');
    await expect(sliders).toHaveCount(4);

    // Verify labels
    await expect(panel).toContainText('向心力');
    await expect(panel).toContainText('排斥力');
    await expect(panel).toContainText('连线拉力');
    await expect(panel).toContainText('连线距离');
  });

  test('old info button is removed', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');
    await expect(page.locator('.graph-page')).toBeVisible({ timeout: 5_000 });

    // The old .graph-info-btn should NOT exist
    await expect(page.locator('.graph-info-btn')).not.toBeAttached({ timeout: 3_000 });
  });
});
