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

  // 「拿不到运行时列表」≠「一个运行时都没装」。
  // 旧逻辑只看 agents 数组是否为空（App.tsx: hasNoUsableAgent = agents.length === 0 || …），
  // 而 useAgents 在请求失败时只 setError、数组保持为空（loading 本身会正常置回 false）——
  // 而「空数组」恰恰就是「没装运行时」的判据。于是 daemon 没起来时，界面会把
  // 「请求失败」当成「没装」，劝用户去安装他明明已经装好的运行时。
  test('runtime list request fails: does not claim "no runtime installed"', async ({ page }) => {
    await page.route('**/api/agents', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"backend down"}' }),
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ locale: 'zh' }) }),
    );
    await gotoHome(page);

    // 失败态用自己的卡片，并说清是「取不到」而非「没装」
    await expect(page.locator('[data-testid="agents-unavailable-card"]')).toBeVisible({ timeout: 5_000 });

    // 关键回归：绝不能出现「没装」那套文案与按钮
    await expect(page.locator('[data-testid="no-runtime-card"]')).toHaveCount(0);
    await expect(page.getByText('未安装 AI 运行时')).toHaveCount(0);
    await expect(page.locator('[data-testid="open-runtimes-btn"]')).toHaveCount(0);
  });

  test('runtime list request fails: retry recovers the composer', async ({ page }) => {
    await page.route('**/api/agents', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"backend down"}' }),
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ locale: 'zh' }) }),
    );
    await gotoHome(page);
    await expect(page.locator('[data-testid="agents-unavailable-card"]')).toBeVisible({ timeout: 5_000 });

    // 后端恢复：换成正常 agents 响应，点「重试」
    await page.unroute('**/api/agents');
    await mockAgent(page);
    await page.locator('[data-testid="agents-retry-btn"]').click();

    // 断言必须是「重试成功」的终态，不能是「重试进行中」的中间帧：
    // 点下去会 setLoading(true)，此时 agentsUnavailable 与 agentsReady 同时为 false，
    // HomePage 于是先渲染出**禁用**的输入框、失败卡同帧卸载 —— 只断言 composer-input
    // 可见的话，抓到的可能就是这个中间帧（那样即使 error 永不清除也照样绿）。
    // 输入框只会在重试**成功**后解除禁用（selectedAgentName 有了值），故用它当判据。
    await expect(page.locator('[data-testid="composer-input"]')).toBeEnabled({ timeout: 5_000 });
    await expect(page.locator('[data-testid="agents-unavailable-card"]')).toHaveCount(0);
  });
});
