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

const { createTabsStore } = await import('../src/stores/kbTabsStore.ts');

/** Open N file tabs in one store, returning the store. */
function openTabs(vaultId: string, paths: string[]) {
  const s = createTabsStore(vaultId);
  for (const p of paths) {
    s.openTab({ id: `file:${p}`, type: 'file', title: p.split('/').pop() ?? p, vaultId });
  }
  return s;
}

const idsOf = (s: ReturnType<typeof createTabsStore>) => s.getTabs().map((t) => t.id);

describe('kbTabsStore.moveTab (drag-to-reorder)', () => {
  it('moves a tab forward: [a,b,c] move a→2 ⇒ [b,c,a]', () => {
    const s = openTabs('mv1', ['a.md', 'b.md', 'c.md']);
    s.moveTab('file:a.md', 2);
    assert.deepStrictEqual(idsOf(s), ['file:b.md', 'file:c.md', 'file:a.md']);
  });

  it('moves a tab backward: [a,b,c] move c→0 ⇒ [c,a,b]', () => {
    const s = openTabs('mv2', ['a.md', 'b.md', 'c.md']);
    s.moveTab('file:c.md', 0);
    assert.deepStrictEqual(idsOf(s), ['file:c.md', 'file:a.md', 'file:b.md']);
  });

  it('keeps activeTabId unchanged after reordering', () => {
    const s = openTabs('mv3', ['a.md', 'b.md', 'c.md']);
    s.activateTab('file:a.md');
    s.moveTab('file:a.md', 2);
    assert.strictEqual(s.getActiveTabId(), 'file:a.md');
    assert.strictEqual(s.getActiveTab()?.id, 'file:a.md');
  });

  it('clamps out-of-range targets (negative → first, beyond-end → last)', () => {
    const s = openTabs('mv4', ['a.md', 'b.md', 'c.md']);
    s.moveTab('file:c.md', -5);
    assert.deepStrictEqual(idsOf(s), ['file:c.md', 'file:a.md', 'file:b.md']);
    s.moveTab('file:c.md', 99);
    assert.deepStrictEqual(idsOf(s), ['file:a.md', 'file:b.md', 'file:c.md']);
  });

  it('unknown id is a no-op', () => {
    const s = openTabs('mv5', ['a.md', 'b.md']);
    s.moveTab('file:ghost.md', 0);
    assert.deepStrictEqual(idsOf(s), ['file:a.md', 'file:b.md']);
  });

  it('same-index move is a no-op (order unchanged)', () => {
    const s = openTabs('mv6', ['a.md', 'b.md', 'c.md']);
    s.moveTab('file:b.md', 1);
    assert.deepStrictEqual(idsOf(s), ['file:a.md', 'file:b.md', 'file:c.md']);
  });

  it('persists the new order — a fresh store instance reads it back', () => {
    const s = openTabs('mv7', ['a.md', 'b.md', 'c.md']);
    s.moveTab('file:c.md', 0);
    assert.deepStrictEqual(idsOf(createTabsStore('mv7')), ['file:c.md', 'file:a.md', 'file:b.md']);
  });

  it('pinned tabs reorder like any other tab (no section constraint)', () => {
    const s = openTabs('mv8', ['a.md', 'b.md', 'c.md']);
    s.togglePin('file:a.md');
    s.moveTab('file:a.md', 2);
    assert.deepStrictEqual(idsOf(s), ['file:b.md', 'file:c.md', 'file:a.md']);
    assert.strictEqual(s.getTabs()[2].pinned, true);
  });

  it('emits exactly once per move; same-index move does not emit', () => {
    const s = openTabs('mv9', ['a.md', 'b.md', 'c.md']);
    let n = 0;
    const un = s.subscribe(() => { n += 1; });
    s.moveTab('file:a.md', 2);
    // 第一次 move 后顺序是 [b,c,a] —— b 已在 index 0，移到 0 是同位 no-op
    s.moveTab('file:b.md', 0);
    assert.strictEqual(n, 1);
    un();
  });
});
