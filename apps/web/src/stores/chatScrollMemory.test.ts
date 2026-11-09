import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberChatScroll,
  recallChatScroll,
  forgetChatScroll,
  findVisibleAnchor,
  applyAnchorOffset,
  MAX_CHAT_SCROLL_ENTRIES,
} from './chatScrollMemory.ts';

// ── 锚点纯函数：宽度不同的表面（全屏 ⇄ 面板）之间按「内容」恢复位置 ──
// 绝对 scrollTop 在重新折行后对应的可见内容会漂移；锚点 = 视口顶第一条
// 消息的序号 + 相对偏移，恢复时把同一条消息钉回同一视口位置。

test('findVisibleAnchor: 视口顶截断那条即锚点（offset 为负）', () => {
  // 三条消息：top 0/300/900，高 300/600/500；scrollTop=350 →
  // 第一条 0..300 已整个滚出（bottom ≤ scrollTop），第二条 300..900 跨过视口顶，
  // 它的顶在视口上 50px → offsetPx = 300 − 350 = −50
  const tops = [0, 300, 900];
  const heights = [300, 600, 500];
  assert.deepEqual(findVisibleAnchor(tops, heights, 350), { index: 1, offsetPx: -50 });
});

test('findVisibleAnchor: 跨视口顶被截断那条（offset 为负）', () => {
  const tops = [0, 300, 900];
  const heights = [300, 600, 500];
  // scrollTop=500：第二条 300..900 跨过视口顶，其顶在视口上 200px
  assert.deepEqual(findVisibleAnchor(tops, heights, 500), { index: 1, offsetPx: -200 });
});

test('findVisibleAnchor: 第一条就从视口顶开始', () => {
  assert.deepEqual(findVisibleAnchor([0, 300], [300, 600], 0), { index: 0, offsetPx: 0 });
});

test('findVisibleAnchor: 残条消息（可见 <24px）不算锚点，落到下一条', () => {
  // scrollTop=3000：第一条 top 2900 高 100 → 底边 3000，可见 0px，跳过；
  // 第二条 top 3000 → 可见 800px，锚它。残条锚点会在宽度不同的表面间翻转
  // （同一条消息窄屏折行变高，露出残条从十几 px 变几十 px，「视口顶第一条」
  // 的观感漂到相邻消息）。
  assert.deepEqual(findVisibleAnchor([2900, 3000], [100, 800], 3000), { index: 1, offsetPx: 0 });
});

test('findVisibleAnchor: 可见量必须超过 24px 才算锚点（严格 >）', () => {
  // top 2900 高 125 → 底边 3024，可见 25px > 24 → 入锚
  assert.deepEqual(findVisibleAnchor([2900], [125], 3000), { index: 0, offsetPx: -100 });
  // 高 124 → 可见恰好 24px，不「超过」→ 跳过（后面没有更多消息）→ null
  assert.equal(findVisibleAnchor([2900], [124], 3000), null);
});

test('findVisibleAnchor: 自定义 minVisiblePx 覆盖默认值', () => {
  // 可见 16px：默认 24 不算，自定义 10 就算
  assert.equal(findVisibleAnchor([2984], [32], 3000), null);
  assert.deepEqual(findVisibleAnchor([2984], [32], 3000, 10), { index: 0, offsetPx: -16 });
});

test('findVisibleAnchor: 消息列表为空 → null（恢复方走兜底）', () => {
  assert.equal(findVisibleAnchor([], [], 100), null);
});

test('applyAnchorOffset: 目标消息存在 → scrollTop = 消息顶 − 偏移', () => {
  assert.equal(applyAnchorOffset(900, { index: 1, offsetPx: -200 }), 1100);
  assert.equal(applyAnchorOffset(300, { index: 0, offsetPx: 0 }), 300);
});

test('applyAnchorOffset: offset 为负（截断态）恢复到负差值', () => {
  // 消息顶 300、offset -50 → scrollTop = 350
  assert.equal(applyAnchorOffset(300, { index: 5, offsetPx: -50 }), 350);
});


// 会话滚动记忆（chatScrollMemory）：
// 语义拍板——记忆存在 ⇄ 标签还开着 ⇄ 切回恢复；标签关闭即删记忆 ⇄ 重开贴底。
// ChatSessionView 持续写入（滚动时），恢复方按 conversationId 取。

test('recall: 存了就取回，top / pinned / anchor 都保留', () => {
  rememberChatScroll('conv-1', { top: 1200, pinned: false, anchor: { index: 3, offsetPx: -40 } });
  assert.deepEqual(recallChatScroll('conv-1'), { top: 1200, pinned: false, anchor: { index: 3, offsetPx: -40 } });

  rememberChatScroll('conv-1', { top: 999_999, pinned: true, anchor: null });
  assert.deepEqual(recallChatScroll('conv-1'), { top: 999_999, pinned: true, anchor: null });
});

test('recall: 未存过的会话返回 null（新会话 → 恢复方走贴底）', () => {
  assert.equal(recallChatScroll('conv-never-saved'), null);
});

test('forget: 删除后取不回（关标签 ⇄ 重开贴底 的实现基础）', () => {
  rememberChatScroll('conv-2', { top: 300, pinned: false, anchor: null });
  assert.notEqual(recallChatScroll('conv-2'), null);
  forgetChatScroll('conv-2');
  assert.equal(recallChatScroll('conv-2'), null);
});

test('forget: 未存过的会话删除是安全 no-op', () => {
  assert.doesNotThrow(() => forgetChatScroll('conv-unknown'));
});

test('remember: conversationId 为空是 no-op（会话未绑定 daemon 时无处可记）', () => {
  assert.doesNotThrow(() => rememberChatScroll('', { top: 100, pinned: true, anchor: null }));
  assert.doesNotThrow(() => rememberChatScroll(null as unknown as string, { top: 100, pinned: true, anchor: null }));
  assert.equal(recallChatScroll(''), null);
});

test(`容量上限 ${MAX_CHAT_SCROLL_ENTRIES}: 超限淘汰最旧，最新保留`, () => {
  for (let i = 0; i < MAX_CHAT_SCROLL_ENTRIES; i++) {
    rememberChatScroll(`lru-old-${i}`, { top: i, pinned: false, anchor: null });
  }
  rememberChatScroll('lru-new', { top: 1, pinned: true, anchor: null });

  assert.equal(recallChatScroll('lru-old-0'), null, '最旧应被淘汰');
  assert.deepEqual(recallChatScroll('lru-new'), { top: 1, pinned: true, anchor: null }, '最新必须保留');
});

test('recall 会刷新 LRU 新鲜度：被读过的旧条目不被下次写入挤掉', () => {
  for (let i = 0; i < MAX_CHAT_SCROLL_ENTRIES; i++) {
    rememberChatScroll(`lru2-${i}`, { top: i, pinned: false, anchor: null });
  }
  // 读最旧的一条 → 它变成最新
  assert.notEqual(recallChatScroll('lru2-0'), null);
  // 再挤一条进来 → 淘汰的应是「未被读过的最旧」，而不是刚被读过的 lru2-0
  rememberChatScroll('lru2-fresh', { top: 0, pinned: false, anchor: null });
  assert.notEqual(recallChatScroll('lru2-0'), null, '刚被 recall 过的不该被淘汰');
  assert.equal(recallChatScroll('lru2-1'), null, '未被访问的最旧被淘汰');
});
