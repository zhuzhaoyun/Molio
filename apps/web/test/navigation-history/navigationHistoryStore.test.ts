/**
 * Unit tests for navigationHistoryStore — the tab-scoped view-history stack.
 *
 * Tracks the order of views (files AND the graph tab) the user has viewed
 * within the KB tab workspace. back()/forward() walk the stack and delegate
 * the actual open to the registered callbacks (file → openFile/handleSelectFile,
 * graph → openGraph/图谱标签激活).
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
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    assert.equal(snap().canGoBack, false);
    assert.equal(snap().canGoForward, false);
  });

  test('push 两条后 canGoBack', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    assert.equal(snap().canGoBack, true);
    assert.equal(snap().canGoForward, false);
  });

  test('连续相同文件去重（不增长栈）', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    assert.equal(snap().canGoBack, false); // 去重后仍只有 1 条
    assert.equal(snap().canGoForward, false);
  });

  test('back 调用 openFile 回到上一条', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.back();
    assert.deepEqual(opened, ['a.md']);
    assert.equal(snap().canGoBack, false);
    assert.equal(snap().canGoForward, true);
  });

  test('forward 调用 openFile 到达下一条', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back();
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.forward();
    assert.deepEqual(opened, ['b.md']);
    assert.equal(snap().canGoForward, false);
  });

  test('栈底 back 为 no-op，不触发 openFile', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.registerOpenFile(() => assert.fail('不应触发'));
    navigationHistoryStore.back();
    assert.equal(snap().canGoBack, false);
  });

  test('栈顶 forward 为 no-op，不触发 openFile', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.registerOpenFile(() => assert.fail('不应触发'));
    navigationHistoryStore.forward();
    assert.equal(snap().canGoForward, false);
  });

  test('后退后新 push 截断前进栈', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'c.md' });
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back(); // 到 b.md
    navigationHistoryStore.push({ kind: 'file', path: 'd.md' }); // 截断 c.md
    assert.equal(snap().canGoBack, true); // a、b 在后面
    assert.equal(snap().canGoForward, false); // c 已被截断
  });

  test('back/forward 触发的重激活被去重（不重复入栈）', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back(); // 到 a.md
    // 模拟激活导致的 activeTab 变化 → 再次 push 当前文件（a.md）→ 应去重
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    assert.equal(snap().canGoBack, false); // 仍在栈底，未新增
    assert.equal(snap().canGoForward, true); // b.md 仍在前进栈
  });

  test('max 50 丢弃最旧条目', () => {
    for (let i = 0; i < 55; i++) navigationHistoryStore.push({ kind: 'file', path: `r${i}.md` });
    for (let i = 0; i < 49; i++) navigationHistoryStore.back();
    // 退回 49 次后到达最旧保留项 r5（r0..r4 被丢弃）
    assert.equal(snap().canGoBack, false);
    const opened: string[] = [];
    navigationHistoryStore.registerOpenFile((fp) => opened.push(fp));
    navigationHistoryStore.back(); // no-op（已到栈底）
    assert.deepEqual(opened, []);
  });
});

describe('navigationHistoryStore — graph 视图条目', () => {
  beforeEach(() => navigationHistoryStore._reset());
  afterEach(() => navigationHistoryStore._reset());

  test('back 落到 graph 条目时经 openGraph（而非 openFile）', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    const openedGraphs: number[] = [];
    navigationHistoryStore.registerOpenGraph(() => openedGraphs.push(1));
    navigationHistoryStore.back(); // b.md → graph
    assert.equal(openedGraphs.length, 1); // 走 openGraph，不走 openFile
    assert.equal(snap().canGoBack, true);
    assert.equal(snap().canGoForward, true);
  });

  test('graph 条目连续去重', () => {
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'graph' });
    assert.equal(snap().canGoBack, false); // 去重后仍只有 1 条
  });

  test('文件与 graph 混合序列：back/forward 按条目类型分发', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });

    const openedFiles: string[] = [];
    const openedGraphs: number[] = [];
    navigationHistoryStore.registerOpenFile((fp) => openedFiles.push(fp));
    navigationHistoryStore.registerOpenGraph(() => openedGraphs.push(1));

    navigationHistoryStore.back(); // → graph
    assert.deepEqual(openedFiles, []);
    assert.equal(openedGraphs.length, 1);
    navigationHistoryStore.back(); // → a.md
    assert.deepEqual(openedFiles, ['a.md']);
    assert.equal(openedGraphs.length, 1);
    navigationHistoryStore.forward(); // → graph
    assert.deepEqual(openedFiles, ['a.md']);
    assert.equal(openedGraphs.length, 2);
    navigationHistoryStore.forward(); // → b.md
    assert.deepEqual(openedFiles, ['a.md', 'b.md']);
    assert.equal(snap().canGoForward, false);
  });

  test('back 到 graph 后重激活 graph 被去重，前进栈保留', () => {
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.registerOpenGraph(() => {});
    navigationHistoryStore.back(); // b.md → graph
    // 模拟 back 导致图谱标签激活 → activeTab 变化再次 push graph → 应去重
    navigationHistoryStore.push({ kind: 'graph' });
    assert.equal(snap().canGoBack, false); // 仍在栈底，未新增
    assert.equal(snap().canGoForward, true); // b.md 仍在前进栈
  });

  test('back 到 graph 后 push 新文件截断前进栈', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.registerOpenFile(() => {});
    navigationHistoryStore.back(); // → graph
    navigationHistoryStore.push({ kind: 'file', path: 'c.md' }); // 截断 b.md
    assert.equal(snap().canGoBack, true); // a.md、graph 在后面
    assert.equal(snap().canGoForward, false); // b.md 已被截断
  });

  test('未注册 openGraph 时 back 到 graph 条目为安全 no-op', () => {
    navigationHistoryStore.push({ kind: 'file', path: 'a.md' });
    navigationHistoryStore.push({ kind: 'graph' });
    navigationHistoryStore.push({ kind: 'file', path: 'b.md' });
    navigationHistoryStore.registerOpenFile(() => assert.fail('不应触发 openFile'));
    assert.doesNotThrow(() => navigationHistoryStore.back()); // b.md → graph：无回调，仅位置前移
    assert.equal(snap().canGoForward, true); // 位置已前移，只是没有回调可执行
  });

});
