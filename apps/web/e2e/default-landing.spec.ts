import { test, expect } from '@playwright/test';

/**
 * @area navigation
 * @priority P1
 *
 * 第 2 步：**打开即进知识库**。
 *
 * `/` 不再是一个页面，而是一次「去哪」的决策：
 *   有上次访问的路由 → 恢复它；否则 → 默认落点（知识库）。
 * 原「首页」（整页对话）本体挪到 `/chat` 并**从导航栏撤下**：它既不是入口，
 * 也不再是一个与知识库并列的导航目的地，只能被深链（历史页回跳、多窗口）抵达。
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

  test('导航栏第一项是知识库，且不再有「首页」项', async ({ page }) => {
    await page.goto('/chat');
    await expect(page.locator('.home-page')).toBeVisible({ timeout: 5_000 });

    const views = await page
      .locator('.entry-nav-rail__group')
      .first()
      .locator('[data-view]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-view')));
    expect(views[0]).toBe('knowledge');
    // 「首页」不再是一个并列目的地：页面本体还在 `/chat`（见上一条深链用例），
    // 但导航栏不该再给出入口 —— 否则等于给「知识库是第一个页面」留了个后门。
    expect(views).not.toContain('home');
  });

  test('零知识库首启：空态给出「新建知识库」CTA，点击进仓库管理器', async ({ page }) => {
    // 零仓库空态现在是**新装用户的第一屏**（`/` → `/knowledge`）。桌面端不挂
    // `/vaults`，`maybeCreateDefaultVault` 不生效，所以这是常态而非边缘情况。
    // 回归点：这里以前只有一句「创建一个知识库」的文案而没有按钮，新用户得自己
    // 找到左下角那条 kb-vault-bar 才进得去。
    //
    // 仓库列表用 route 伪装成空：daemon 是干净的（MOLIO_DATA_DIR 一次一清），
    // 但同一次跑里别的 spec 会建库，靠"真的没有仓库"来断言会随执行顺序飘。
    // 正则锚到列表端点本身：宽 glob 会连 `.../vaults/<id>/tree` 一起吞掉。
    await page.route(/\/api\/knowledge\/vaults(\?.*)?$/, (route) =>
      route.fulfill({ json: { vaults: [] } }),
    );

    await page.goto('/knowledge');
    // 限定 .kb-main：文件面板的「Empty vault」也用 .kb-empty-state，
    // 不限定会 strict 冲突（见 kb-chat-entry.spec.ts 同款注释）
    const empty = page.locator('.kb-main .kb-empty-state');
    await expect(empty).toContainText('欢迎使用知识库', { timeout: 5_000 });

    const cta = page.locator('[data-testid="kb-empty-create-vault-cta"]');
    await expect(cta).toBeVisible();
    await cta.click();

    // 落到仓库管理器：面板可见，且「创建」动作可用（而不是把自己又关回去）
    await expect(page.locator('.vm-action-btn-primary')).toBeVisible({ timeout: 5_000 });
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
