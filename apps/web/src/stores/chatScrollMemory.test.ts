import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberChatScroll,
  recallChatScroll,
  forgetChatScroll,
  MAX_CHAT_SCROLL_ENTRIES,
} from './chatScrollMemory.ts';

// 会话滚动记忆（chatScrollMemory）：
// 语义拍板——记忆存在 ⇄ 标签还开着 ⇄ 切回恢复；标签关闭即删记忆 ⇄ 重开贴底。
// ChatSessionView 持续写入（滚动时），恢复方按 conversationId 取。

test('recall: 存了就取回，top 与 pinned 都保留', () => {
  rememberChatScroll('conv-1', { top: 1200, pinned: false });
  assert.deepEqual(recallChatScroll('conv-1'), { top: 1200, pinned: false });

  rememberChatScroll('conv-1', { top: 999_999, pinned: true });
  assert.deepEqual(recallChatScroll('conv-1'), { top: 999_999, pinned: true });
});

test('recall: 未存过的会话返回 null（新会话 → 恢复方走贴底）', () => {
  assert.equal(recallChatScroll('conv-never-saved'), null);
});

test('forget: 删除后取不回（关标签 ⇄ 重开贴底 的实现基础）', () => {
  rememberChatScroll('conv-2', { top: 300, pinned: false });
  assert.notEqual(recallChatScroll('conv-2'), null);
  forgetChatScroll('conv-2');
  assert.equal(recallChatScroll('conv-2'), null);
});

test('forget: 未存过的会话删除是安全 no-op', () => {
  assert.doesNotThrow(() => forgetChatScroll('conv-unknown'));
});

test('remember: conversationId 为空是 no-op（会话未绑定 daemon 时无处可记）', () => {
  assert.doesNotThrow(() => rememberChatScroll('', { top: 100, pinned: true }));
  assert.doesNotThrow(() => rememberChatScroll(null as unknown as string, { top: 100, pinned: true }));
  assert.equal(recallChatScroll(''), null);
});

test(`容量上限 ${MAX_CHAT_SCROLL_ENTRIES}: 超限淘汰最旧，最新保留`, () => {
  for (let i = 0; i < MAX_CHAT_SCROLL_ENTRIES; i++) {
    rememberChatScroll(`lru-old-${i}`, { top: i, pinned: false });
  }
  rememberChatScroll('lru-new', { top: 1, pinned: true });

  assert.equal(recallChatScroll('lru-old-0'), null, '最旧应被淘汰');
  assert.deepEqual(recallChatScroll('lru-new'), { top: 1, pinned: true }, '最新必须保留');
});

test('recall 会刷新 LRU 新鲜度：被读过的旧条目不被下次写入挤掉', () => {
  for (let i = 0; i < MAX_CHAT_SCROLL_ENTRIES; i++) {
    rememberChatScroll(`lru2-${i}`, { top: i, pinned: false });
  }
  // 读最旧的一条 → 它变成最新
  assert.notEqual(recallChatScroll('lru2-0'), null);
  // 再挤一条进来 → 淘汰的应是「未被读过的最旧」，而不是刚被读过的 lru2-0
  rememberChatScroll('lru2-fresh', { top: 0, pinned: false });
  assert.notEqual(recallChatScroll('lru2-0'), null, '刚被 recall 过的不该被淘汰');
  assert.equal(recallChatScroll('lru2-1'), null, '未被访问的最旧被淘汰');
});
