import { test, expect } from '@playwright/test';
import { clickNav } from './helpers/navigation';

/**
 * @area navigation
 * @priority P1
 *
 * 第 2 步：**打开即进知识库**。
 *
 * `/` 不再是一个页面，而是一次「去哪」的决策：
 *   有上次访问的路由 → 恢复它；否则 → 默认落点（知识库）。
 * 首页本体挪到 `/chat`，因此它仍可被深链、被导航栏直接抵达，
 * 只是不再是应用入口。
 *
 * 这样 `gotoHome` 这类「显式 goto 某个页面」的用法不受入口改动影响
 * ——入口只影响 `/` 这一个地址，不劫持其他路由。
 */
test.describe('默认落点：打开即进知识库', () => {
  test('冷启动访问 `/` → 重定向到知识库', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/knowledge/, { timeout: 5_000 });
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });
    // 不应停在 `/`（那是入口地址，不是页面）
    await expect(page.locator('.home-page')).toHaveCount(0);
  });

  test('首页本体仍在 `/chat`，可被深链直接抵达', async ({ page }) => {
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/chat$/, { timeout: 5_000 });
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
    // 没有被入口重定向劫走
    await expect(page.locator('.kb-shell')).toHaveCount(0);
  });

  test('导航栏第一项是知识库（落地页与导航一致）', async ({ page }) => {
    await page.goto('/chat');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    const views = await page
      .locator('.entry-nav-rail__group')
      .first()
      .locator('[data-view]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-view')));
    expect(views[0]).toBe('knowledge');
    // 「首页」入口仍在，只是不再排第一（名字待定，此断言只看顺序）
    expect(views).toContain('home');
  });

  test('导航栏「首页」入口 → `/chat`（整页对话仍可达）', async ({ page }) => {
    await page.goto('/knowledge');
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    await clickNav(page, 'home');
    await expect(page).toHaveURL(/\/chat$/, { timeout: 5_000 });
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });
  });

  test('入口的 query 在重定向中原样保留（?vault= / ?file= 是跨路由深链参数）', async ({ page }) => {
    // 回归：入口若用 `<Navigate to="/knowledge">` 丢掉 search，
    // 「打开某库的某个文件」会被降级成「打开某库」——vaultStore 与
    // KnowledgeBasePage 都从 URL 读这两个参数。
    await page.goto('/?vault=abc-123&file=wiki/x.md');
    await expect(page).toHaveURL(/\/knowledge\?vault=abc-123&file=wiki\/x\.md$/, { timeout: 5_000 });
  });

  test('老数据的 molio.lastRoute === "/" 不会造成重定向死循环', async ({ page }) => {
    // 历史版本里 `/` 就是首页，会被写进 molio.lastRoute。
    // 若把它当成合法目标，`/` → `/` 会自我重定向。
    await page.goto('/chat');
    await page.evaluate(() => localStorage.setItem('molio.lastRoute', '/'));
    await page.goto('/');
    await expect(page).toHaveURL(/\/knowledge/, { timeout: 5_000 });
  });
});
