import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area chat
 * @priority P1
 *
 * 会话滚动记忆（chatScrollMemory + ChatSessionView 恢复）—— 2026-11-09 拍板的语义：
 * 1. 没关的标签切回（全屏切标签 / 面板切标签）→ 恢复到切换前的位置，不回底部；
 * 2. 同一标签的表面切换（全屏 ⇄ 面板）→ 位置跟着走（全屏里读到的位置带回面板，反之亦然）；
 * 3. 切走前贴底 → 切回仍贴底（pinned 语义：后台长高了贴新底）；
 * 4. 关掉的标签从历史重开 → 贴底（关标签即删记忆）。
 *
 * 根因（修复前）：全屏只有一个共享 ChatSessionView，切标签 = conversationId 变化
 * → 有意复位贴底；进全屏 = 全新 view 挂载 → 贴底；面板 ⇄ 全屏位置互不带。
 * 本 spec 修复前 1/2 必红，4 是「删记忆」语义的守卫（没删的话恢复旧位置会红）。
 *
 * 造数据方式：不真发消息（mockChatRun 所有发送绑同一 convId，造不出两条会话），
 * 直接 mock 历史列表 + 每会话的长消息历史，经「历史下拉 → 就地切换」把两条长会话
 * 分别装进两个标签。
 */

/** 一条长会话的消息历史：user/assistant 交替，assistant 段足够长，撑出多屏高度。 */
function longHistory(prefix: string, marker: string) {
  const msgs = [];
  for (let i = 0; i < 20; i++) {
    msgs.push({ id: `${prefix}-u-${i}`, role: 'user', content: `${marker} 提问 ${i}`, timestamp: 1700000000000 + i * 2 });
    msgs.push({
      id: `${prefix}-a-${i}`,
      role: 'assistant',
      content: `${marker} 回答 ${i}。` + '这是一段用来把消息区撑到远超一屏高度的长文内容，位置记忆的断言依赖它有足够的高度。'.repeat(40),
      timestamp: 1700000000000 + i * 2 + 1,
    });
  }
  return msgs;
}

/** mock 两条长历史会话（会话甲 / 会话乙）+ 空活跃 run 列表。 */
async function mockTwoLongConvs(page: Page) {
  const item = (id: string, title: string, updatedAt: number) => ({
    conversation: { id, title, updatedAt },
    lastMessage: null,
    messageCount: 40,
  });
  // 列表路由须匹配带/不带查询串两种 URL，但不能命中 /api/conversations/:id/messages
  await page.route(/\/api\/conversations(?:\?|$)/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pinnedItems: [],
        items: [item('conv-a', '会话甲', 1700000100000), item('conv-b', '会话乙', 1700000090000)],
        nextCursor: null,
      }),
    }));
  await page.route('**/api/conversations/conv-a/messages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: longHistory('a', '会话甲') }),
    }));
  await page.route('**/api/conversations/conv-b/messages', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ messages: longHistory('b', '会话乙') }),
    }));
  // maybeResume / resumeRun 询问活跃 run：空列表 → 不恢复直播
  await page.route('**/api/runs', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) });
    }
    return route.fallback();
  });
}

/** 面板当前可见会话的消息区（多会话常驻挂载，必须限定 :visible）。 */
function panelChatLog(page: Page) {
  return page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible [data-testid="chat-log"]');
}

/** 全屏 shell 的消息区（面板 view 此时 visibility:hidden，必须 scope 到 shell 避免歧义）。 */
function fullscreenChatLog(page: Page) {
  return page.locator('.home-page.chat-active [data-testid="chat-log"]');
}

/** 面板里把两条长会话分别装进两个标签：标签1=会话甲，标签2=会话乙（乙为活动）。 */
async function openTwoLongTabs(page: Page, vault: TempVault) {
  await mockTwoLongConvs(page);
  // 相对路径走 playwright baseURL —— 端口可平移（MOLIO_E2E_WEB_PORT），不硬编码 5173
  await page.goto(`/knowledge?vault=${vault.id}&file=doc.md`);
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });

  await page.locator('[data-testid="kb-btn-ask"]').click();
  await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

  // 历史下拉把会话甲装进标签1
  await page.locator('[data-testid="kb-chat-session-history"]').click();
  await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
    .filter({ hasText: '会话甲' }).click();
  await expect(panelChatLog(page)).toContainText('会话甲 回答 19', { timeout: 10_000 });

  // 新标签2，历史下拉把会话乙装进标签2（就地切换，不新增标签）
  await page.locator('[data-testid="kb-chat-session-new"]').click();
  await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
  await page.locator('[data-testid="kb-chat-session-history"]').click();
  await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
    .filter({ hasText: '会话乙' }).click();
  await expect(panelChatLog(page)).toContainText('会话乙 回答 19', { timeout: 10_000 });
}

/** 进入全屏 shell，等消息区可见。 */
async function enterFullscreen(page: Page) {
  await page.locator('[data-testid="kb-chat-fullscreen"]').click();
  await expect(fullscreenChatLog(page)).toBeVisible({ timeout: 10_000 });
}

let vault: TempVault;

test.describe('Chat scroll memory', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-chat-scroll-memory');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('全屏切标签：切回恢复到切换前的位置（不回底部）', async ({ page }) => {
    await openTwoLongTabs(page, vault);
    await enterFullscreen(page);

    // 全屏当前是会话乙；先切到甲（甲的记忆=贴底，落在底部是预期）
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(fullscreenChatLog(page)).toContainText('会话甲 回答 19', { timeout: 10_000 });

    // 甲上翻到顶阅读 → 脱离贴底，浮标出现
    await fullscreenChatLog(page).evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.home-page.chat-active [data-testid="chat-jump-bottom"]')).toBeVisible({ timeout: 5_000 });

    // 切到乙再切回甲 → 甲必须还在顶部附近，而不是被拽回底部
    await page.locator('[data-testid="kb-chat-session-tab"]').nth(1).click();
    await expect(fullscreenChatLog(page)).toContainText('会话乙 回答 19', { timeout: 10_000 });
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(fullscreenChatLog(page)).toContainText('会话甲 回答 19', { timeout: 10_000 });

    // 恢复到切换前的顶部（修复前：conversationId 复位把它拽回底部）
    await expect.poll(async () =>
      fullscreenChatLog(page).evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeLessThan(200);
    const distToBottom = await fullscreenChatLog(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(distToBottom).toBeGreaterThan(120);
    await expect(page.locator('.home-page.chat-active [data-testid="chat-jump-bottom"]')).toBeVisible();
  });

  test('全屏 ⇄ 面板：同一标签位置互带', async ({ page }) => {
    await openTwoLongTabs(page, vault);
    await enterFullscreen(page);

    // 全屏里把会话乙翻到顶部
    await fullscreenChatLog(page).evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.home-page.chat-active [data-testid="chat-jump-bottom"]')).toBeVisible({ timeout: 5_000 });

    // 最小化回面板 → 乙还在顶部（修复前：面板 view 是进全屏前的旧位置=底部）
    await page.locator('[data-testid="home-minimize-btn"]').click();
    await expect(panelChatLog(page)).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () =>
      panelChatLog(page).evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeLessThan(200);

    // 面板里滚到中段，再进全屏 → 同一位置（修复前：全新挂载回底部）
    await panelChatLog(page).evaluate((el) => { el.scrollTop = 3000; });
    await enterFullscreen(page);
    await expect.poll(async () =>
      fullscreenChatLog(page).evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBe(3000);
  });

  test('面板切标签：切回恢复位置（贴底语义不回归）', async ({ page }) => {
    await openTwoLongTabs(page, vault);

    // 乙上翻到顶 → 浮标出现
    await panelChatLog(page).evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-jump-bottom"]')
      .filter({ visible: true })).toBeVisible({ timeout: 5_000 });

    // 切到甲（甲保持贴底），再切回乙 → 乙恢复顶部
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(panelChatLog(page)).toContainText('会话甲 回答 19', { timeout: 10_000 });
    // 甲此刻应仍在底部（贴底语义）：距底 ≤ 阈值
    const distBottomA = await panelChatLog(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    expect(distBottomA).toBeLessThanOrEqual(120);

    await page.locator('[data-testid="kb-chat-session-tab"]').nth(1).click();
    await expect(panelChatLog(page)).toContainText('会话乙 回答 19', { timeout: 10_000 });
    await expect.poll(async () =>
      panelChatLog(page).evaluate((el) => el.scrollTop), { timeout: 5_000 }).toBeLessThan(200);
  });

  test('关闭标签从历史重开 → 贴底（关标签即删记忆）', async ({ page }) => {
    await openTwoLongTabs(page, vault);
    await enterFullscreen(page);
    // 乙翻到顶，留下一条「中段位置」的记忆
    await fullscreenChatLog(page).evaluate((el) => { el.scrollTop = 0; });
    await expect(page.locator('.home-page.chat-active [data-testid="chat-jump-bottom"]')).toBeVisible({ timeout: 5_000 });

    // 回面板，关掉乙标签
    await page.locator('[data-testid="home-minimize-btn"]').click();
    await expect(panelChatLog(page)).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="kb-chat-session-tab"]')
      .nth(1).locator('[data-testid="kb-chat-session-tab-close"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);

    // 新标签 + 历史重开乙 → 贴底、无浮标（若记忆没删，会恢复到顶部位置 → 红）
    await page.locator('[data-testid="kb-chat-session-new"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2);
    await page.locator('[data-testid="kb-chat-session-history"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
      .filter({ hasText: '会话乙' }).click();
    await expect(panelChatLog(page)).toContainText('会话乙 回答 19', { timeout: 10_000 });

    await expect.poll(async () =>
      panelChatLog(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
      { timeout: 5_000 }).toBeLessThanOrEqual(120);
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-jump-bottom"]')
      .filter({ visible: true })).toBeHidden();
  });
});
