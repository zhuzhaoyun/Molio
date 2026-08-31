/**
 * Unit tests for navigationHistoryStore — the tab-scoped view-history stack.
 *
 * Tracks the order of files the user has viewed within the KB tab workspace.
 * back()/forward() walk the stack and delegate the actual tab activation to the
 * registered openFile callback. Pruned so it only ever contains currently-open
 * tabs (closed tabs drop out).
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { navigationHistoryStore } from '../../src/stores/navigationHistoryStore.ts';

const snap = () => navigationHistoryStore.getSnapshot();

beforeEach(() => navigationHistoryStore._reset());
afterEach(() => navigationHistoryStore._reset());

describe('navigationHistoryStore', () => {
  test('reset 后无历史，两个方向都不可用', () => {
    assert.equal(snap().canGoBack, false);
    assert.equal(snap().canGoForward, false);
  });

  test('push 单条：两方向不可用', () => {
    navigationHistoryStore.push('a.md');
    assert.equal(snap().canGoBack, false);
    assert.equal(snap().canGoForward, false);
  });

  test('push 两条后 canGoBack', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    assert.equal(snap().canGoBack, true);
    assert.equal(snap().canGoForward, false);
  });

  test('连续相同文件去重（不增长栈）', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('a.md');
    assert.equal(snap().canGoBack, false); // 去重后仍只有 1 条
    assert.equal(snap().canGoForward, false);
  });

  test('back 调用 openFile 回到上一条', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.back();
    assert.deepEqual(opened, ['a.md']);
    assert.equal(snap().canGoBack, false);
    assert.equal(snap().canGoForward, true);
  });

  test('forward 调用 openFile 到达下一条', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back();
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.forward();
    assert.deepEqual(opened, ['b.md']);
    assert.equal(snap().canGoForward, false);
  });

  test('栈底 back 为 no-op，不触发 openFile', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.registerOpenFile(() => assert.fail('不应触发'));
    navigationHistoryStore.back();
    assert.equal(snap().canGoBack, false);
  });

  test('栈顶 forward 为 no-op，不触发 openFile', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.registerOpenFile(() => assert.fail('不应触发'));
    navigationHistoryStore.forward();
    assert.equal(snap().canGoForward, false);
  });

  test('后退后新 push 截断前进栈', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    navigationHistoryStore.push('c.md');
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back(); // 到 b.md
    navigationHistoryStore.push('d.md'); // 截断 c.md
    assert.equal(snap().canGoBack, true); // a、b 在后面
    assert.equal(snap().canGoForward, false); // c 已被截断
  });

  test('back/forward 触发的重激活被去重（不重复入栈）', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back(); // 到 a.md
    // 模拟激活导致的 activeTab 变化 → 再次 push 当前文件（a.md）→ 应去重
    navigationHistoryStore.push('a.md');
    assert.equal(snap().canGoBack, false); // 仍在栈底，未新增
    assert.equal(snap().canGoForward, true); // b.md 仍在前进栈
  });

  test('max 50 丢弃最旧条目', () => {
    for (let i = 0; i < 55; i++) navigationHistoryStore.push(`r${i}.md`);
    for (let i = 0; i < 49; i++) navigationHistoryStore.back();
    // 退回 49 次后到达最旧保留项 r5（r0..r4 被丢弃）
    assert.equal(snap().canGoBack, false);
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.back(); // no-op（已到栈底）
    assert.deepEqual(opened, []);
  });

  test('prune 丢弃已关闭文件，保持顺序与索引', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    navigationHistoryStore.push('c.md');
    navigationHistoryStore.prune(new Set(['a.md', 'c.md'])); // 关掉 b.md
    assert.equal(snap().canGoBack, true); // c 前面仍有 a
    assert.equal(snap().canGoForward, false);
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.back(); // → a.md（b 已被剔除）
    assert.deepEqual(opened, ['a.md']);
  });

  test('prune 后当前文件也被关闭时索引回退到边界', () => {
    navigationHistoryStore.push('a.md');
    navigationHistoryStore.push('b.md');
    navigationHistoryStore.push('c.md');
    navigationHistoryStore.back(); // 到 b.md（index 1）
    navigationHistoryStore.prune(new Set(['a.md'])); // 只留 a.md
    assert.equal(snap().canGoBack, false); // 已回退到唯一条目
    assert.equal(snap().canGoForward, false);
  });
});
