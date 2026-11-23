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

/** 视口顶应钉在第 idx 条 user 消息顶部 - 8px（±4px 容差；poll 消化跳转双 rAF
 *  与浮标进流的时序——CI 与本地帧时序不同，一次性读值会竞态）。 */
async function expectPinnedToUserMsg(page: Page, idx: number) {
  await expect.poll(async () => {
    const vals = await panelLog(page).evaluate((el, i) => {
      const users = Array.from(el.querySelectorAll('[data-testid="user-message"]'));
      const first = users[i];
      if (!first) return { delta: Number.MAX_SAFE_INTEGER };
      const top = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      // 末轮回答较短时目标位置超出 maxScrollTop，浏览器钳到边界——这是滚动
      // 边界的正确语义：断言「钉住目标 或 恰好钳在 maxScrollTop」。
      return { delta: Math.abs(el.scrollTop - Math.min(top - 8, el.scrollHeight - el.clientHeight)) };
    }, idx);
    return vals.delta;
  }, { timeout: 2_000, message: `视口顶应钉在第 ${idx} 条 user 消息（目标或钳位 ±4px）` }).toBeLessThanOrEqual(4);
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
    // 高亮唯一：恰好一个 active 刻度（截图验收曾误读为多个——钉死它）
    await expect(panelRail(page).locator('.is-active')).toHaveCount(1);
    // 对齐参考原型（豆包/DSH）：刻度块纵向居中——块中心 ≈ 轨道中心（±2px），
    // 而不是 flex-start 贴顶。
    await page.waitForTimeout(250); // 等挂载动画结算
    const first = await panelTicks(page).nth(0).boundingBox();
    const last = await panelTicks(page).nth(2).boundingBox();
    const rail = await panelRail(page).boundingBox();
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    expect(rail).not.toBeNull();
    const topRel = first!.y - rail!.y;
    const bottomRel = last!.y + last!.height - rail!.y;
    const blockCenter = (topRel + bottomRel) / 2;
    const railCenter = rail!.height / 2;
    expect(Math.abs(blockCenter - railCenter), '刻度块应纵向居中').toBeLessThanOrEqual(2);
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
    // 平滑动画守卫（回归曾把点击变瞬移）：click 返回时滚动尚未开始——
    // 双 rAF + smooth 下 scrollTop 仍应停在出发地（贴底 ~3000px）附近。
    const s0 = await panelLog(page).evaluate((el) => el.scrollTop);
    expect(s0, '点击后不应瞬移到目标').toBeGreaterThan(500);
    await expectPinnedToUserMsg(page, 0);
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-jump-bottom"]')).toBeVisible();
    // 中位刻度也准
    await panelTicks(page).nth(1).click();
    await expectPinnedToUserMsg(page, 1);
    // 跳转后高亮 = 被跳到的刻度本身：视口顶的 8px 呼吸位不算阅读区——
    // 前一对的尾巴伸进呼吸位时不得抢走高亮（验收：回车后高亮落在隔壁格）。
    await expect(panelTicks(page).nth(1)).toHaveClass(/is-active/);
  });

  test('hover 刻度 → 提问预览（含该问文本、不被容器裁剪）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    const tick = panelTicks(page).nth(1);
    await tick.hover();
    const preview = page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-preview"]');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('第 1 问');
    // 元信息行：hover 第 2 格（nth(1)）→ 序号显示「第 2 问」
    await expect(preview.locator('.chat-message-rail-preview-meta')).toHaveText('第 2 问');
    // 假绿守卫：toBeVisible 不查祖先 overflow 裁剪（曾把气泡整个吃掉仍绿）——
    // 几何断言气泡真实可见：右缘不越过刻度、左缘不出消息区。
    const pbox = await preview.boundingBox();
    const tbox = await tick.boundingBox();
    const lbox = await panelLog(page).boundingBox();
    expect(pbox).not.toBeNull();
    expect(tbox).not.toBeNull();
    expect(lbox).not.toBeNull();
    expect(pbox!.x + pbox!.width, '气泡右缘应在刻度左侧').toBeLessThanOrEqual(tbox!.x + 1);
    expect(pbox!.x, '气泡左缘不应出消息区').toBeGreaterThanOrEqual(lbox!.x);
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

  test('拖动刷选：按住轨道拖到中位刻度 → 视口即时跟随、松手停在该轮', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    const first = await panelTicks(page).nth(0).boundingBox();
    const mid = await panelTicks(page).nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(mid).not.toBeNull();
    await page.mouse.move(first!.x + first!.width / 2, first!.y + first!.height / 2);
    await page.mouse.down();
    await page.mouse.move(mid!.x + mid!.width / 2, mid!.y + mid!.height / 2, { steps: 6 });
    await page.mouse.up();
    // 拖选是即时跳转（无平滑动画），落位断言可直接读
    await expectPinnedToUserMsg(page, 1);
    // 拖动中预览跟手：松手后 hover 仍在（指针停在轨道上），元信息对应第 2 问
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-preview"]')).toContainText('第 2 问');
  });

  test('键盘走格：↑/↓ 移动焦点并联动预览，Enter 跳转', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    await panelTicks(page).nth(0).click();
    await expectPinnedToUserMsg(page, 0);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-preview"]')).toContainText('第 2 问');
    await page.keyboard.press('Enter');
    await expectPinnedToUserMsg(page, 1);
    // 用户实测路径：回车后高亮必须是选中的那格（不是隔壁）
    await expect(panelTicks(page).nth(1)).toHaveClass(/is-active/);
  });

  test('rail 不遮原生滚动条（右缘距 log 右缘 ≥6px）', async ({ page }) => {
    await openQaWithConv(page, vault, 'conv-rail', '出题会话', 3);
    // 等挂载动画（180ms translateX）结算——boundingBox 量的是 transform 后的盒子，
    // 动画中途量会带着残影偏移。
    await page.waitForTimeout(250);
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

  test('M2 预览元信息：出题轮 hover 显示「第 N 问 · N 卡」，普通轮只有「第 N 问」', async ({ page }) => {
    // M2（spec §4.2-1）：出题轮的预览元信息带该轮渲染出的题卡数
    // （contracts countQuizCards 同口径）；无题卡轮自然退化只有「第 N 问」。
    const quizMsgs = [
      { id: 'q-u0', role: 'user', content: '第一章出五道选择题', timestamp: 1700000000000 },
      { id: 'q-a0', role: 'assistant', content: '好的。\n\n```quiz\n{"version":1,"title":"第一章 · 5 题","questions":[{"id":"c1","type":"single","stem":"1+1=?","options":[{"key":"A","text":"2"},{"key":"B","text":"3"}],"answer":["A"],"explanation":"e","sources":[{"path":"doc.md"}]},{"id":"c2","type":"judge","stem":"对。","answer":["A"],"explanation":"e","sources":[{"path":"doc.md"}]}]}\n```\n\n再来一张：\n\n```quiz\n{"version":1,"title":"加练","questions":[{"id":"c3","type":"fill","stem":"____ 是答案。","answer":["A"],"explanation":"e","sources":[{"path":"doc.md"}]}]}\n```', timestamp: 1700000000001 },
      { id: 'q-u1', role: 'user', content: '第二章也出几道', timestamp: 1700000000002 },
      { id: 'q-a1', role: 'assistant', content: '第二章内容较长。' + LONG, timestamp: 1700000000003 },
      { id: 'q-u2', role: 'user', content: '第三章继续', timestamp: 1700000000004 },
      { id: 'q-a2', role: 'assistant', content: '第三章答。' + LONG, timestamp: 1700000000005 },
    ];
    await mockConv(page, 'conv-quiz-meta', '出题带卡会话', quizMsgs);
    await page.goto(`/knowledge?vault=${vault.id}&file=doc.md`);
    await expect(page.locator('.kb-shell')).toBeVisible({ timeout: 10_000 });
    await page.locator('[data-testid="kb-btn-ask"]').click();
    await expect(page.locator('[data-testid="kb-chat-session-tab"]')).toHaveCount(1);
    await page.locator('[data-testid="kb-chat-session-history"]').click();
    await page.locator('[data-testid="kb-chat-panel"] [data-testid="composer-history-item"]')
      .filter({ hasText: '出题带卡会话' }).click();
    await expect(page.locator('[data-testid="kb-chat-panel"] [data-testid="chat-message-rail-tick"]')).toHaveCount(3, { timeout: 10_000 });

    const panel = page.locator('[data-testid="kb-chat-panel"]');
    const preview = panel.locator('[data-testid="chat-message-rail-preview"]');
    const meta = preview.locator('.chat-message-rail-preview-meta');
    // 出题轮（tick 0）：第 1 问 · 2 卡
    await panelTicks(page).nth(0).hover();
    await expect(preview).toBeVisible();
    await expect(meta).toHaveText('第 1 问 · 2 卡');
    // 普通轮（tick 1）：退化只有第 N 问
    await panelTicks(page).nth(1).hover();
    await expect(meta).toHaveText('第 2 问');
  });
});
