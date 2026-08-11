// apps/web/e2e/kb-chat-resume.spec.ts
import { test, expect } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area kb
 * @priority P1
 * 进行中回复被 UI 抛弃的恢复：切页返回 / 运行中切历史 → 恢复直播（不中断回复）。
 * 根因：run 在 daemon 侧一直活着，SSE 断开只是丢监听；Web 端重挂载后必须按
 * conversationId 定位活跃 run 重新订阅（?after 缺省 → 从 seq 0 回放 buffer 事件）。
 * Prerequisites: `pnpm dev`.
 */

/**
 * 每个会话都常驻一个 .file-chat-messages 容器（空态 .file-chat-empty 也嵌在里面），
 * 多会话共存时必须限定到可见（激活）会话，否则 strict mode 会因命中多个元素而报错。
 */
function activeMessages(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible .file-chat-messages');
}

/**
 * 预置一条历史会话 conv-h（标题「历史问题」+ 1 条 user 消息）。composer 历史下拉
 * 与全局历史页共用。列表路由须同时匹配带查询串（历史页 ?limit=50）与不带（composer）
 * 两种 URL，但不能命中 /api/conversations/:id/messages —— 用正则限定 ? 或结尾即可。
 */
async function mockHistoryConv(page: import('@playwright/test').Page) {
  const listBody = JSON.stringify({
    pinnedItems: [],
    items: [{
      conversation: { id: 'conv-h', title: '历史问题', updatedAt: Date.now() },
      lastMessage: null,
      messageCount: 1,
    }],
    nextCursor: null,
  });
  await page.route(/\/api\/conversations(?:\?|$)/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: listBody }));
  await page.route('**/api/conversations/conv-h/messages', (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', content: '历史问题', timestamp: Date.now() }] }),
    }));
}

let vault: TempVault;

test.describe('KB chat resume', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-resume');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('切页返回后，进行中的回复恢复直播', async ({ page }) => {
    // persistedMessages：DB 里只有 user 消息（assistant 回复未及持久化，turn_end 才入库）
    // → 重挂载后恢复活跃 run，回放重建完整回复。
    await mockChatRun(page, {
      frameDelay: 100,
      persistedMessages: [{ id: 'um1', role: 'user', content: '请生成一篇长文', timestamp: Date.now() }],
    });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 发送 → 等 run 进入 running（5 帧 × 100ms，mid-stream 时切走）
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('请生成一篇长文');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="kb-chat-session-running"]'))
      .toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(250); // 只播了 ~2-3 帧，仍在流式

    // 切走（卸载 KB 页 → unmount cleanup 调 reset 丢弃 run）→ 再返回 /knowledge
    await page.goto('http://localhost:5173/history');
    await expect(page.locator('.history-shell')).toBeVisible({ timeout: 5_000 });
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 标签从 localStorage 恢复；重挂载后从 DB 加载（只有 user 消息）→ maybeResume 定位
    // 活跃 run → 重新订阅回放全部事件 → 完整回复重建（此时面板是 is-hidden 态，先重开）
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(activeMessages(page)).toContainText('how can I help you?', { timeout: 10_000 });
    // 回放结束后 run 被正确接管，running 指示消失（不是永久卡住）
    await expect(page.locator('[data-testid="kb-chat-session-running"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test('运行中切历史 → 开新标签保留直播，原会话回复完整', async ({ page }) => {
    await mockChatRun(page, { frameDelay: 100 });
    await mockHistoryConv(page);
    await page.goto(`http://localhost:5173/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 5_000 });

    // 发送 → 等 run 进入 running
    await page.locator('[data-testid="kb-btn-ask"]').click();
    const input = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await input.fill('请生成一篇长文');
    await page.locator('[data-testid="composer-send"]').click();
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="kb-chat-session-running"]'))
      .toBeVisible({ timeout: 5_000 });

    // 运行中从历史下拉打开 conv-h → 必须开新标签（就地切换会 setMessages 丢弃直播 run）
    await page.locator('[data-testid="kb-chat-session-history"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
      .filter({ hasText: '历史问题' }).click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(2, { timeout: 5_000 });
    // 新活动标签显示历史会话内容（conv-h 无活跃 run → 静态历史，不误恢复）
    await expect(activeMessages(page)).toContainText('历史问题', { timeout: 5_000 });

    // 切回第一个标签 → 原回复完整（后台保活 + 切历史未打断）
    await page.locator('[data-testid="kb-chat-session-tab"]').first().click();
    await expect(activeMessages(page)).toContainText('Hello,', { timeout: 5_000 });
  });
});
