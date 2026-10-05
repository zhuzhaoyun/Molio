import { test, expect } from '@playwright/test';
import { gotoHome, waitForLanding } from './helpers/navigation';
import { mockAgent, mockNoAgents } from './helpers/mock-sse';

/**
 * @area navigation
 * @priority P0
 *
 * E2E tests for app bootstrap and first render.
 *
 * Verifies that the application loads correctly, the landing page renders,
 * the composer is available, and the navigation rail shows all expected items.
 *
 * Prerequisites: `pnpm dev` running (daemon :3100, web :5173)
 */

test.describe('App bootstrap', () => {
  test('app loads and shows landing page', async ({ page }) => {
    await gotoHome(page);

    await expect(page.locator('.home-landing')).toBeVisible();
    await expect(page.locator('[data-testid="hero-brand"]')).toContainText('Molio');
  });

  test('composer is visible and ready', async ({ page }) => {
    // Mock a usable agent so the composer renders regardless of the CI runner
    // having no runtime installed. Without this, a no-runtime run would show
    // the NoRuntimeCard instead of the composer and fail here.
    await mockAgent(page);
    await gotoHome(page);

    const composer = page.locator('[data-testid="composer-input"]');
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();
  });

  test('nav rail shows all navigation items', async ({ page }) => {
    await gotoHome(page);

    const nav = page.locator('.entry-nav-rail');
    await expect(nav).toBeVisible();

    // Verify all nav items are present (knowledge, graph, resources, history, account, settings, help).
    // 「home」不在其中：`/` 已直接落到知识库，原「首页」不再是并列的导航目的地，
    // 页面本体仍在 `/chat` 但只由深链抵达（见 default-landing.spec.ts）。
    const expectedViews = ['knowledge', 'graph', 'resources', 'history', 'account', 'settings', 'help'];
    for (const view of expectedViews) {
      await expect(page.locator(`[data-view="${view}"]`)).toBeVisible();
    }
  });

  test('hero shows tagline', async ({ page }) => {
    await gotoHome(page);
    await waitForLanding(page);

    await expect(page.locator('[data-testid="hero-tagline"]')).toBeVisible();
  });

  test('no runtime: shows NoRuntimeCard and deep-links to settings-runtimes', async ({ page }) => {
    await mockNoAgents(page);
    await gotoHome(page);

    // 卡片替代输入框
    await expect(page.locator('[data-testid="no-runtime-card"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="composer-input"]')).not.toBeVisible();

    // 主按钮复用 button.primary：hover 应为 accent-hover 深珊瑚，而非 base 的浅灰（回归断言）
    const btn = page.locator('[data-testid="open-runtimes-btn"]');
    await expect(btn).toHaveCSS('background-color', 'rgb(201, 100, 66)');
    await btn.hover();
    await expect(btn).toHaveCSS('background-color', 'rgb(168, 86, 54)');

    // 点击按钮 → 深链到 /settings?tab=runtimes，运行时 tab 激活
    await btn.click();
    await expect(page).toHaveURL(/\/settings\?tab=runtimes$/);
    await expect(page.locator('[data-testid="settings-tab-runtimes"]')).toHaveClass(/is-active/);
    await expect(page.locator('.rt-shell')).toBeVisible({ timeout: 5_000 });
  });
});
