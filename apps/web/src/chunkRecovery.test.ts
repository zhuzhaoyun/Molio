import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChunkLoadError,
  createChunkRecovery,
  installChunkRecovery,
  type RecoveryStore,
} from './chunkRecovery.ts';

/** 最小内存 store，模拟 sessionStorage。 */
function memoryStore(): RecoveryStore {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

describe('isChunkLoadError', () => {
  it('识别 Vite 的动态模块拉取失败（本次线上报错原文）', () => {
    assert.equal(
      isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: http://localhost:3100/assets/SettingsPage-BXHmWwZJ.js')),
      true,
    );
  });

  it('识别 Chromium 的 module script 导入失败变体', () => {
    assert.equal(isChunkLoadError(new TypeError('Importing a module script failed.')), true);
  });

  it('普通运行时错误不是 chunk 加载错误', () => {
    assert.equal(isChunkLoadError(new TypeError('x is not a function')), false);
    assert.equal(isChunkLoadError(new Error('boom')), false);
    assert.equal(isChunkLoadError(null), false);
    assert.equal(isChunkLoadError(undefined), false);
  });
});

describe('createChunkRecovery', () => {
  it('首次请求刷新并记录时间戳', () => {
    let reloaded = 0;
    const store = memoryStore();
    const recovery = createChunkRecovery({
      now: () => 1000,
      reload: () => void reloaded++,
      store,
    });
    assert.equal(recovery.requestReload(), true);
    assert.equal(reloaded, 1);
    assert.equal(store.getItem('molio:chunk-reload-at'), '1000');
  });

  it('冷却窗口内的再次失败不重复刷新（防循环）', () => {
    let clock = 1000;
    let reloaded = 0;
    const recovery = createChunkRecovery({
      now: () => clock,
      reload: () => void reloaded++,
      store: memoryStore(),
    });
    assert.equal(recovery.requestReload(), true);
    clock += 5000;
    assert.equal(recovery.requestReload(), false);
    assert.equal(reloaded, 1, '5s 后仍在冷却窗口内，不应刷新');
  });

  it('冷却窗口过后允许再次刷新', () => {
    let clock = 1000;
    let reloaded = 0;
    const recovery = createChunkRecovery({
      now: () => clock,
      reload: () => void reloaded++,
      store: memoryStore(),
    });
    recovery.requestReload();
    clock += 16_000;
    assert.equal(recovery.requestReload(), true);
    assert.equal(reloaded, 2);
  });

  it('store 读取失败按无记录处理，不抛错', () => {
    let reloaded = 0;
    const recovery = createChunkRecovery({
      now: () => 1000,
      reload: () => void reloaded++,
      store: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      },
    });
    assert.equal(recovery.requestReload(), true);
    assert.equal(reloaded, 1);
  });
});

describe('installChunkRecovery', () => {
  it('监听 vite:preloadError：preventDefault 并刷新', () => {
    const listeners = new Map<string, (e: { preventDefault(): void }) => void>();
    const target = {
      addEventListener: (type: 'vite:preloadError', fn: (e: { preventDefault(): void }) => void) => void listeners.set(type, fn),
    };
    let reloaded = 0;
    const recovery = installChunkRecovery(target, {
      now: () => 1000,
      reload: () => void reloaded++,
      store: memoryStore(),
    });
    assert.ok(listeners.has('vite:preloadError'), '应注册 vite:preloadError 监听');

    let prevented = false;
    listeners.get('vite:preloadError')!({
      preventDefault: () => void (prevented = true),
    });
    assert.equal(prevented, true, '应阻止 Vite 默认的未处理 rejection');
    assert.equal(reloaded, 1);
    // install 返回的 recovery 与监听器共享同一份冷却窗口
    assert.equal(recovery.requestReload(), false);
  });
});
