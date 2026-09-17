import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import {
  toAbsoluteVaultPath,
  isRevealAvailable,
  revealInFolder,
} from './reveal.ts';

/**
 * 「在文件夹中显示」util：
 * - toAbsoluteVaultPath 把 agent 上报的不稳定路径形态（相对 / ./ 前缀 / 绝对 / Windows 反斜杠）
 *   归一为绝对路径——与 writeKey 同一语义（剥 ./ 与 vault 前缀的反向操作）。
 * - isRevealAvailable / revealInFolder 只在 Electron 桌面壳（window.__electron__）下可用，
 *   纯浏览器返回 false，调用方据此不渲染入口。
 */
describe('toAbsoluteVaultPath', () => {
  it('相对路径拼接 vaultPath', () => {
    assert.equal(toAbsoluteVaultPath('/Users/u/vault', 'notes/a.md'), '/Users/u/vault/notes/a.md');
  });

  it('剥离 ./ 前缀再拼接', () => {
    assert.equal(toAbsoluteVaultPath('/Users/u/vault', './notes/a.md'), '/Users/u/vault/notes/a.md');
  });

  it('vaultPath 尾斜杠不产生双斜杠', () => {
    assert.equal(toAbsoluteVaultPath('/Users/u/vault/', 'a.md'), '/Users/u/vault/a.md');
  });

  it('已是 vault 内绝对路径则原样返回，不二次前缀', () => {
    assert.equal(
      toAbsoluteVaultPath('/Users/u/vault', '/Users/u/vault/notes/a.md'),
      '/Users/u/vault/notes/a.md',
    );
  });

  it('Windows 反斜杠绝对路径归一为正斜杠', () => {
    assert.equal(
      toAbsoluteVaultPath('C:\\Users\\u\\vault', 'C:\\Users\\u\\vault\\notes\\a.md'),
      'C:/Users/u/vault/notes/a.md',
    );
  });

  it('Windows vaultPath + 反斜杠相对路径拼接并归一', () => {
    assert.equal(
      toAbsoluteVaultPath('C:\\Users\\u\\vault', 'notes\\a.md'),
      'C:/Users/u/vault/notes/a.md',
    );
  });
});

describe('isRevealAvailable', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('纯浏览器（无 window.__electron__）不可用', () => {
    (globalThis as { window?: unknown }).window = {};
    assert.equal(isRevealAvailable(), false);
  });

  it('无 window（非浏览器环境）不可用', () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(isRevealAvailable(), false);
  });

  it('桌面壳注入 showItemInFolder 时可用', () => {
    (globalThis as { window?: unknown }).window = {
      __electron__: { showItemInFolder: () => Promise.resolve() },
    };
    assert.equal(isRevealAvailable(), true);
  });
});

describe('revealInFolder', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('可用时以绝对路径调用 showItemInFolder 并返回 true', async () => {
    const calls: string[] = [];
    (globalThis as { window?: unknown }).window = {
      __electron__: {
        showItemInFolder: (p: string) => { calls.push(p); return Promise.resolve(); },
      },
    };
    const ok = revealInFolder('/Users/u/vault', 'notes/a.md');
    assert.equal(ok, true);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, ['/Users/u/vault/notes/a.md']);
  });

  it('不可用时返回 false 且不抛错', () => {
    delete (globalThis as { window?: unknown }).window;
    assert.equal(revealInFolder('/Users/u/vault', 'a.md'), false);
  });

  it('showItemInFolder 拒绝（文件已不存在）不产生未处理拒绝', async () => {
    (globalThis as { window?: unknown }).window = {
      __electron__: { showItemInFolder: () => Promise.reject(new Error('gone')) },
    };
    assert.equal(revealInFolder('/Users/u/vault', 'gone.md'), true);
    await new Promise((r) => setTimeout(r, 0));
  });
});
