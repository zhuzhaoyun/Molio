import { test, expect } from '@playwright/test';
import { gotoHome, clickNav } from './helpers/navigation';

/**
 * @area navigation
 * @priority P1
 *
 * E2E tests for navigation between all main pages.
 *
 * Verifies that every page is reachable via the NavRail and that the
 * active state is correctly highlighted.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('Navigation', () => {
  test('navigate to knowledge base', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'knowledge');

    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/knowledge');
  });

  test('graph entry lands in the knowledge-base workspace', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'graph');

    // 图谱不再有独立页：入口跳转知识库工作区（勾选 graph 标签需先有 vault，见 graph.spec）
    await expect(page).toHaveURL(/\/knowledge/, { timeout: 5_000 });
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
  });

  test('navigate to history', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'history');

    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/history');
  });

  test('navigate to settings', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'settings');

    await expect(page.locator('.settings-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/settings');
  });

  test('navigate to resources', async ({ page }) => {
    await gotoHome(page);
    await clickNav(page, 'resources');

    await expect(page.locator('.resources-shell')).toBeVisible({ timeout: 5_000 });
    expect(page.url()).toContain('/resources');
  });

  test('navigate back to knowledge base from another page', async ({ page }) => {
    // 原来这条用「首页」做回跳目标。首页已从导航栏移除（`/` 直接落到知识库，
    // 它不再是并列目的地），回跳目标改为落地页本身；覆盖点不变：
    // 往返可达 + 当前项高亮。
    await gotoHome(page);
    await clickNav(page, 'settings');
    await expect(page.locator('.settings-shell')).toBeVisible();

    await clickNav(page, 'knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-view="knowledge"]')).toHaveClass(/is-active/);
  });
});
