import { describe, it } from 'node:test';
import assert from 'node:assert';

const KEY = 'molio.vaultSwitchWindow';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

let scenario = 0;
async function freshUtil(opts: { stored?: string; storageThrows?: boolean } = {}) {
  const storage = new MemStorage();
  if (opts.stored !== undefined) storage.setItem(KEY, opts.stored);
  if (opts.storageThrows) {
    storage.getItem = () => { throw new Error('denied'); };
    storage.setItem = () => { throw new Error('denied'); };
  }
  (globalThis as Record<string, unknown>).localStorage = storage;
  (globalThis as Record<string, unknown>).window = new EventTarget();
  scenario += 1;
  return await import(`../src/utils/vaultSwitchWindow.ts?s=${scenario}`);
}

describe('vaultSwitchWindow 读值', () => {
  it('缺 key → new-window / shouldReuse=false', async () => {
    const mod = await freshUtil();
    assert.strictEqual(mod.readVaultSwitchWindowMode(), 'new-window');
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), false);
  });

  it("'reuse' → true；'new-window' → false", async () => {
    const mod = await freshUtil({ stored: 'reuse' });
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), true);
    const mod2 = await freshUtil({ stored: 'new-window' });
    assert.strictEqual(mod2.shouldReuseWindowOnVaultSwitch(), false);
  });

  it("非法值（'bogus' / ''）容错为缺省", async () => {
    const mod = await freshUtil({ stored: 'bogus' });
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), false);
    const mod2 = await freshUtil({ stored: '' });
    assert.strictEqual(mod2.shouldReuseWindowOnVaultSwitch(), false);
  });

  it('localStorage 读抛错（隐私模式）→ 回退缺省', async () => {
    const mod = await freshUtil({ storageThrows: true });
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), false);
  });
});

describe('vaultSwitchWindow 写入与多窗同步', () => {
  it('set 后同窗口立即可读新值（storage 事件不投递给动手窗口，setter 必须自更缓存）', async () => {
    const mod = await freshUtil();
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), false);
    mod.setVaultSwitchWindowMode('reuse');
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), true);
  });

  it('另一窗口原始写入 + storage 事件 → 本窗口缓存失效、读到新值', async () => {
    const mod = await freshUtil();
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), false); // 缓存 false
    const storage = (globalThis as { localStorage: MemStorage }).localStorage;
    storage.setItem(KEY, 'reuse'); // 模拟别的窗口写 localStorage（绕过 setter）
    (globalThis as { window: EventTarget }).window.dispatchEvent(new Event('storage'));
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), true);
  });

  it('set 写 localStorage 抛错 → 内存态仍生效（不抛出）', async () => {
    const mod = await freshUtil({ storageThrows: true });
    mod.setVaultSwitchWindowMode('reuse');
    assert.strictEqual(mod.shouldReuseWindowOnVaultSwitch(), true);
  });
});
