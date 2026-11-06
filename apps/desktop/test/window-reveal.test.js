/**
 * Regression: a window whose page load never finishes must still become visible.
 *
 * 报障（2026-10-16，Windows v0.3.61-beta）：切换知识库不弹新窗口、点「设置」页面
 * 不切换（macOS 同版本正常）。根因在 daemon（单线程整库冷索引独占事件循环，连
 * 自己托管的 SPA 静态资源都发不出去 → 懒路由 chunk 请求与 loadURL 双双挂起），
 * 见 apps/daemon/src/core/vault-search.ts。但壳层放大了它：窗口以 show:false
 * 创建，只有 did-finish-load 才 show()——加载挂起 = 窗口永远不可见，任务栏里
 * 也没有它，用户只看到「点了没反应」。
 *
 * 本文件锁住壳层不变量：显示时机有兜底时限，超时也必须把窗口显示出来。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRevealGate, APP_LOAD_REVEAL_TIMEOUT_MS } from '../src/window-reveal.js';

/** 假定时器：手动触发，不依赖真实时间（CI 负载不影响结论）。 */
function fakeTimers() {
  let cb = null;
  return {
    setTimeoutFn: (fn) => { cb = fn; return 1; },
    clearTimeoutFn: () => { cb = null; },
    /** 触发兜底；定时器已被清掉时返回 false（= 真实世界里它不会发生）。 */
    fire: () => {
      const fn = cb;
      cb = null;
      if (!fn) return false;
      fn();
      return true;
    },
    isArmed: () => cb !== null,
  };
}

describe('createRevealGate — 窗口显示闸门', () => {
  it('页面加载完成 → 立即显示，并撤掉兜底定时器', () => {
    const t = fakeTimers();
    const seen = [];
    const gate = createRevealGate({ timeoutMs: 5000, onReveal: (r) => seen.push(r), ...t });
    gate.loaded();
    assert.deepEqual(seen, ['loaded']);
    assert.equal(t.isArmed(), false, '加载完成后兜底定时器必须被清掉');
  });

  it('加载迟迟不结束 → 超时也显示窗口（本次报障的核心）', () => {
    const t = fakeTimers();
    const seen = [];
    createRevealGate({ timeoutMs: 5000, onReveal: (r) => seen.push(r), ...t });
    t.fire();
    assert.deepEqual(seen, ['timeout'], '超时是这种情况下唯一的可见路径，必须触发 onReveal');
  });

  it('只显示一次：先超时后加载完成不再重复显示；先加载完成后超时也不再触发', () => {
    const t = fakeTimers();
    const seen = [];
    const gate = createRevealGate({ timeoutMs: 5000, onReveal: (r) => seen.push(r), ...t });
    t.fire();
    gate.loaded();
    assert.deepEqual(seen, ['timeout']);

    const t2 = fakeTimers();
    const seen2 = [];
    const gate2 = createRevealGate({ timeoutMs: 5000, onReveal: (r) => seen2.push(r), ...t2 });
    gate2.loaded();
    assert.equal(t2.fire(), false, '已显示过就不该再有超时兜底触发');
    assert.deepEqual(seen2, ['loaded']);
  });

  it('cancel 后兜底不再触发（窗口已销毁，别对着死窗口 show）', () => {
    const t = fakeTimers();
    const seen = [];
    const gate = createRevealGate({ timeoutMs: 5000, onReveal: (r) => seen.push(r), ...t });
    gate.cancel();
    assert.equal(t.isArmed(), false);
    assert.deepEqual(seen, []);
  });

  it('兜底时限远长于正常加载（不然会先撞上它，白闪一个空窗口）', () => {
    assert.ok(
      APP_LOAD_REVEAL_TIMEOUT_MS >= 3000 && APP_LOAD_REVEAL_TIMEOUT_MS <= 10000,
      `兜底时限 ${APP_LOAD_REVEAL_TIMEOUT_MS}ms 应在 3–10s 之间`,
    );
  });
});

describe('main.js — 显示路径必须走闸门', () => {
  const mainSource = readFileSync(path.join(import.meta.dirname, '..', 'src', 'main.js'), 'utf-8');

  function fnBody(name) {
    const start = mainSource.indexOf(name);
    assert.ok(start !== -1, `${name} 必须存在`);
    const end = mainSource.indexOf('\nfunction ', start + 1);
    return mainSource.slice(start, end > start ? end : start + 2000);
  }

  it('loadAppWindow 用 createRevealGate，且不再自己直接 show()', () => {
    const body = fnBody('function loadAppWindow(');
    assert.ok(
      body.includes('createRevealGate('),
      'loadAppWindow 必须用闸门控制显示时机——只等 did-finish-load 会让挂起的加载永远不可见',
    );
    assert.ok(
      body.includes('gate.loaded()'),
      'did-finish-load 必须走 gate.loaded()（闸门里去重并发/超时）',
    );
    assert.ok(
      !body.includes('win.show()'),
      'loadAppWindow 不得直接 win.show()——否则绕过闸门，超时兜底形同虚设',
    );
  });

  it('加载失败的分支不解除兜底（错误页自己也可能加载不出来）', () => {
    const body = fnBody('function loadAppWindow(');
    const failPos = body.indexOf('const onFail');
    assert.ok(failPos !== -1, 'onFail 处理器必须存在');
    // 只看 onFail 处理器本身（到注册监听为止），后面的 win.once('closed')
    // 走 cancel 是另一回事：窗口都没了，兜底显示没有意义。
    const listenPos = body.indexOf('wc.once(', failPos);
    const failBlock = body.slice(failPos, listenPos > failPos ? listenPos : failPos + 600);
    assert.ok(
      !failBlock.includes('gate.cancel()'),
      '失败分支不得 cancel 闸门——daemon-error.html 若也加载失败，窗口仍须被超时兜底显示出来',
    );
  });

  it('daemon 错误页同样走闸门', () => {
    const body = fnBody('function showDaemonErrorPage(');
    assert.ok(body.includes('createRevealGate('), '错误页也必须带兜底显示');
  });

  it('revealAppWindow 是唯一的 show() 出口，且对已销毁窗口免疫', () => {
    const body = fnBody('function revealAppWindow(');
    assert.ok(body.includes('win.show()'), 'revealAppWindow 负责真正 show()');
    assert.ok(
      body.includes('isDestroyed()'),
      'revealAppWindow 必须先判 isDestroyed()——超时回调可能在窗口关闭后才跑',
    );
    assert.ok(
      mainSource.includes("import { createRevealGate, APP_LOAD_REVEAL_TIMEOUT_MS } from './window-reveal.js'"),
      'main.js 必须从 window-reveal.js 引入闸门',
    );
  });
});
