import { describe, it } from 'node:test';
import assert from 'node:assert';

// node:test 环境没有 localStorage —— 注入内存 stub（store 仅在函数调用时访问它）
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as Record<string, unknown>).localStorage = new MemStorage();

const { createSplitViewStore } = await import('../src/stores/splitViewStore.ts');

describe('splitViewStore', () => {
  it('defaults: companion=null, ratio=0.5', () => {
    const s = createSplitViewStore('v1');
    assert.strictEqual(s.getCompanion(), null);
    assert.strictEqual(s.getRatio(), 0.5);
  });

  it('setCompanion(graph) persists and reloads from the same key', () => {
    const s = createSplitViewStore('v2');
    s.setCompanion({ type: 'graph' });
    assert.deepStrictEqual(s.getCompanion(), { type: 'graph' });
    // 新实例（模拟刷新后）从 localStorage 恢复
    const s2 = createSplitViewStore('v2');
    assert.deepStrictEqual(s2.getCompanion(), { type: 'graph' });
  });

  it('setCompanion(file) persists filePath', () => {
    const s = createSplitViewStore('v3');
    s.setCompanion({ type: 'file', filePath: 'docs/a.md' });
    assert.deepStrictEqual(createSplitViewStore('v3').getCompanion(), { type: 'file', filePath: 'docs/a.md' });
  });

  it('setCompanion(null) clears and persists', () => {
    const s = createSplitViewStore('v4');
    s.setCompanion({ type: 'graph' });
    s.setCompanion(null);
    assert.strictEqual(createSplitViewStore('v4').getCompanion(), null);
  });

  it('setRatio clamps to [0.25, 0.75]', () => {
    const s = createSplitViewStore('v5');
    s.setRatio(0.1); assert.strictEqual(s.getRatio(), 0.25);
    s.setRatio(0.9); assert.strictEqual(s.getRatio(), 0.75);
    s.setRatio(0.6); assert.strictEqual(s.getRatio(), 0.6);
  });

  it('subscribe fires on change; unsubscribe stops', () => {
    const s = createSplitViewStore('v6');
    let n = 0;
    const un = s.subscribe(() => { n += 1; });
    s.setCompanion({ type: 'graph' });
    s.setRatio(0.7);
    assert.strictEqual(n, 2);
    un();
    s.setCompanion(null);
    assert.strictEqual(n, 2);
  });

  it('idempotent setCompanion does not re-emit', () => {
    const s = createSplitViewStore('v7');
    s.setCompanion({ type: 'graph' });
    let n = 0;
    const un = s.subscribe(() => { n += 1; });
    s.setCompanion({ type: 'graph' });
    assert.strictEqual(n, 0);
    un();
  });

  it('stores are isolated per vault', () => {
    const a = createSplitViewStore('va');
    const b = createSplitViewStore('vb');
    a.setCompanion({ type: 'graph' });
    assert.strictEqual(b.getCompanion(), null);
  });

  it('malformed persisted JSON falls back to defaults without throwing', () => {
    localStorage.setItem('molio.kb.split.vbad', '{oops');
    const s = createSplitViewStore('vbad');
    assert.strictEqual(s.getCompanion(), null);
    assert.strictEqual(s.getRatio(), 0.5);
  });
});
