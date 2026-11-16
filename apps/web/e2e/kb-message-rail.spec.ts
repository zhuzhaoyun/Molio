// apps/web/e2e/kb-message-rail.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { createTempVault, cleanupTempVault, type TempVault } from './helpers/cleanup';
import { mockChatRun, unmockAll } from './helpers/mock-sse';
import * as fs from 'fs';
import * as path from 'path';

/**
 * @area chat
 * @priority P1
 *
 * KB 问答消息导航 rail（docs/2026-11-16-message-rail-design.md）：
 * ≥3 提问且溢出才出现；点击跳到该提问并脱离贴底；hover 出预览；
 * 勾选删除态隐藏；不遮原生滚动条；追加消息后刻度与落位不陈旧。
 * 造数：mock 历史会话（N user + 高个 assistant），经「历史下拉 → 就地切换」装进
 * 活动会话（模式抄 chat-scroll-memory.spec.ts，相对路径走 baseURL，不硬编码端口）。
 */

const LONG = '这是一段用来把消息区撑到远超一屏高度的长文内容，rail 的可见阈值依赖它有足够的高度。'.repeat(40);

function history(rounds: number): Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> {
  const msgs: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ id: `u-${i}`, role: 'user', content: `第 ${i} 问：请就第${i}章出五道选择题`, timestamp: 1700000000000 + i * 2 });
    msgs.push({ id: `a-${i}`, role: 'assistant', content: `第 ${i} 答。` + LONG, timestamp: 1700000000000 + i * 2 + 1 });
  }
  return msgs;
}

/** mock 一条历史会话 + 空活跃 run 列表。 */
async function mockConv(page: Page, id: string, title: string, msgs: unknown[]) {
  await page.route(/\/api\/conversations(?:\?|$)/, (route) =>
    route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        pinnedItems: [],
        items: [{ conversation: { id, title, updatedAt: 1700000100000 }, lastMessage: null, messageCount: msgs.length }],
        nextCursor: null,
      }),
    }));
  await page.route(`**/api/conversations/${id}/messages`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: msgs }) }));
  await page.route('**/api/runs', (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ runs: [] }) });
    }
    return route.fallback();
  });
}

/** 面板当前可见会话的消息区。 */
function panelLog(page: Page) {
  return page.locator('[data-testid="kb-chat-panel"] .file-chat-session:visible [data-testid="chat-log"]');
}
function panelRail(page: Page) {
  return page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail"]');
}
function panelTicks(page: Page) {
  return page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-tick"]');
}

/** 打开 KB 页 → 建问答标签 → 历史下拉就地切到指定会话，等末轮回答可见。 */
async function openQaWithConv(page: Page, vault: TempVault, id: string, title: string, rounds: number) {
  await mockConv(page, id, title, history(rounds));
  await page.goto(`/knowledge?vault=${vault.id}&file=doc.md`);
  await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
  await page.locator('[data-testid="kb-btn-ask"]').click();
  await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
  await page.locator('[data-testid="kb-chat-session-history"]').click();
  await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
    .filter({ hasText: title }).click();
  await expect(panelLog(page)).toContainText(`第 ${rounds - 1} 答`, { timeout: 10_000 });
}

/** 视口顶应钉在第 idx 条 user 消息顶部 - 8px（±4px 容差）。 */
async function expectPinnedToUserMsg(page: Page, idx: number) {
  const vals = await panelLog(page).evaluate((el, i) => {
    const users = Array.from(el.querySelectorAll('[data-testid="user-message"]'));
    const first = users[i];
    if (!first) return false;
    const top = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    // 末轮回答较短时目标位置超出 maxScrollTop，浏览器钳到边界——这是滚动
    // 边界的正确语义：断言「钉住目标 或 恰好钳在 maxScrollTop」。
    return { scrollTop: el.scrollTop, target: top - 8, maxScroll: el.scrollHeight - el.clientHeight };
  }, idx);
  const expected = Math.min(vals.target, vals.maxScroll);
  expect(Math.abs(vals.scrollTop - expected), `视口顶应钉在第 ${idx} 条 user 消息：scrollTop=${vals.scrollTop} target=${vals.target} maxScroll=${vals.maxScroll}`).toBeLessThanOrEqual(4);
}

let vault: TempVault;

test.describe('KB message rail', () => {
  test.beforeAll(async () => {
    vault = await createTempVault('e2e-kb-message-rail');
    fs.writeFileSync(path.join(vault.path, 'doc.md'), '# Doc\n');
  });
  test.afterAll(async () => { if (vault) await cleanupTempVault(vault); });
  test.afterEach(async ({ page }) => { await unmockAll(page); });

  test('≥3 提问且溢出 → rail 出现，刻度数 = 提问数', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await expect(panelRail(page)).toBeVisible();
    await expect(panelTicks(page)).toHaveCount(3);
  });

  test('2 提问 → 不出现（阈值之下）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-short', '短会话', 2);
    await expect(panelTicks(page)).toHaveCount(0);
    await expect(panelRail(page)).toHaveCount(0);
  });

  test('点击刻度 → 跳到该提问顶对齐并脱离贴底（回底浮标出现）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    // 历史加载后贴底：回底浮标不可见
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-jump-bottom"]')).toBeHidden();
    await panelTicks(page).nth(0).click();
    await expectPinnedToUserMsg(page, 0);
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-jump-bottom"]')).toBeVisible();
    // 中位刻度也准
    await panelTicks(page).nth(1).click();
    await expectPinnedToUserMsg(page, 1);
  });

  test('hover 刻度 → 提问预览（含该问文本）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await panelTicks(page).nth(1).hover();
    const preview = page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-preview"]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('第 1 问');
  });

  test('追加一轮消息 → 刻度数 +1，点新刻度落位不陈旧', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await mockChatRun(page, { conversationId: 'conv-rail', persistedMessages: history(3) });
    const textarea = page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-input"]');
    await textarea.fill('第四问：请就第四章出三道判断题');
    await textarea.press('Enter');
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="user-message"]')).toHaveCount(4, { timeout: 10_000 });
    await expect(panelTicks(page)).toHaveCount(4, { timeout: 10_000 });
    // 等本轮回答落地后再点（几何终态稳定；末轮回答短时的钳位由断言语义覆盖）。
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="assistant-message"]')).toHaveCount(4, { timeout: 10_000 });
    // 贴底跟随新回答 → 点新刻度（第 4 条提问），仍要精确落位
    await panelTicks(page).nth(3).click();
    await expectPinnedToUserMsg(page, 3);
  });

  test('勾选删除态 → rail 隐藏，退出恢复', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await expect(panelRail(page)).toBeVisible();
    const panel = page.locator('[data-testid="kb-chat-panel"]');
    await panel.locator('[data-testid="assistant-message"]').first().hover();
    await panel.locator('[data-testid="assistant-message"] [data-testid="msg-overflow-btn"]').first().click();
    await panel.locator('[data-testid="overflow-item-delete"]').click();
    await expect(page.locator('[data-testid="selection-confirm-bar"]')).toBeVisible();
    await expect(panelRail(page)).toHaveCount(0);
    await page.locator('[data-testid="selection-cancel-btn"]').click();
    await expect(panelRail(page)).toBeVisible();
  });

  test('rail 不遮原生滚动条（右缘距 log 右缘 ≥6px）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    const railBox = await panelRail(page).boundingBox();
    const logBox = await panelLog(page).boundingBox();
    expect(railBox).not.toBeNull();
    expect(logBox).not.toBeNull();
    expect(railBox!.x + railBox!.width, 'rail 右缘应在 log 右缘左侧 ≥6px').toBeLessThanOrEqual(logBox!.x + logBox!.width - 6);
  });

  test('全屏形态（HomePage 接线点）→ rail 同样出现', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await page.locator('[data-testid="kb-chat-fullscreen"]').click();
    await expect(page.locator('.home-page.chat-active [data-testid="chat-log"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.home-page.chat-active [data-testid="chat-message-rail"]')).toBeVisible();
    await expect(page.locator('.home-page.chat-active [data-testid="chat-message-rail-tick"]')).toHaveCount(3);
  });
});
