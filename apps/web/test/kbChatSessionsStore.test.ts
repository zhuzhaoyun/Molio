/**
 * kbChatSessionsStore —— 会话标签按知识库隔离。
 *
 * 回归背景（2026-11 用户报障）：切换到另一个知识库后，原知识库的会话标签仍然
 * 出现在新库的会话标签栏里（点进去查不到内容）。根因是 store 的会话清单**与库无关**：
 * 标签栏渲染全部会话，而 `vaultId` 只被 controller 用来「重置」会话（清空内容），
 * 于是旧库的标签变成了空壳仍留在新库里。
 *
 * 这里钉住新的语义：
 * - 每个会话归属一个库（创建时打戳，缺省 = 当前活跃库）；
 * - 可见会话 = 当前库的会话（切库即隐藏，切回即恢复）；
 * - 活动会话按库取作用域（不跨库）；
 * - 标签上限按库计（A 库占满不妨碍 B 库开新会话）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// node:test 环境没有 localStorage / window —— 注入内存 stub（store 仅在调用时访问）
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const STORAGE_KEY_SESSIONS = 'molio.kb.chatSessions';

let scenario = 0;
/**
 * 每个场景一份干净的存储 + 干净的 store 实例（模块状态在 import 时初始化，
 * 用查询串让 Node ESM 把它当成不同模块重新求值）。
 */
async function freshStore(opts: { persistedSessions?: unknown; activeVaultId?: string | null } = {}) {
  const storage = new MemStorage();
  if (opts.persistedSessions !== undefined) {
    storage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(opts.persistedSessions));
  }
  (globalThis as Record<string, unknown>).localStorage = storage;
  (globalThis as Record<string, unknown>).window = { location: { search: '' } };
  scenario += 1;
  const vaultMod = await import('../src/stores/vaultStore.ts');
  vaultMod.__setActiveVaultSyncer(async () => {});
  // 活跃库必须先于 store 的 import 就位（迁移旧会话时要读它）
  vaultMod.vaultStore.setActiveVaultId(opts.activeVaultId ?? null);
  const mod = await import(`../src/stores/kbChatSessionsStore.ts?s=${scenario}`);
  return {
    store: mod.kbChatSessionsStore,
    vaultStore: vaultMod.vaultStore,
    storage,
    MAX: mod.MAX_CHAT_SESSIONS,
  };
}

describe('kbChatSessionsStore —— 会话标签按库隔离', () => {
  it('新建会话自动归属当前活跃库', async () => {
    const { store } = await freshStore({ activeVaultId: 'vault-a' });
    const res = store.openSession({ mode: 'qa', title: '新会话', conversationId: null });
    assert.strictEqual(res.tab?.vaultId, 'vault-a');
  });

  it('可见会话只含本库：别的库的会话不出现在标签栏', async () => {
    const { store } = await freshStore({ activeVaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'A 会话', conversationId: null, vaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'B 会话', conversationId: null, vaultId: 'vault-b' });

    assert.deepStrictEqual(store.getSessionsForVault('vault-a').map((s) => s.title), ['A 会话']);
    assert.deepStrictEqual(store.getSessionsForVault('vault-b').map((s) => s.title), ['B 会话']);
    // 底层清单仍保留两个库的会话（切回去要能恢复）
    assert.strictEqual(store.getSessions().length, 2);
  });

  it('活动会话按库取作用域：切库后活动的是本库那个', async () => {
    const { store, vaultStore } = await freshStore({ activeVaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'A 会话', conversationId: null, vaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'B 会话', conversationId: null, vaultId: 'vault-b' });
    // 当前库是 A → 活动会话是 A 那个（B 的会话在别的库，不可见也不能当活动）
    assert.strictEqual(store.getActiveSession()?.title, 'A 会话');
    assert.strictEqual(store.getActiveSessionId(), store.getSessionsForVault('vault-a')[0]?.id);

    // 切到 B → 活动会话跟着换成 B 那个
    vaultStore.setActiveVaultId('vault-b');
    assert.strictEqual(store.getActiveSession()?.title, 'B 会话');
    assert.strictEqual(store.getActiveSessionId(), store.getSessionsForVault('vault-b')[0]?.id);
  });

  it('标签上限按库计：A 库占满不妨碍 B 库开新会话', async () => {
    const { store, MAX } = await freshStore({ activeVaultId: 'vault-a' });
    for (let i = 0; i < MAX; i++) {
      store.openSession({ mode: 'qa', title: `A${i}`, conversationId: null, vaultId: 'vault-a' });
    }
    assert.strictEqual(
      store.openSession({ mode: 'qa', title: 'A-超额', conversationId: null, vaultId: 'vault-a' }).reason,
      'limit',
    );
    // 另一个库不受影响
    const res = store.openSession({ mode: 'qa', title: 'B0', conversationId: null, vaultId: 'vault-b' });
    assert.strictEqual(res.opened, true);
  });

  it('旧会话（没有 vaultId 字段）迁移到当前活跃库，不会到处漂', async () => {
    const persisted = [{
      id: 'chat:old', title: '旧会话', conversationId: 'conv-1', mode: 'qa', filePath: null,
    }];
    const { store } = await freshStore({ persistedSessions: persisted, activeVaultId: 'vault-a' });
    assert.strictEqual(store.getSessions()[0]?.vaultId, 'vault-a');
    assert.strictEqual(store.getSessionsForVault('vault-a').length, 1);
    assert.strictEqual(store.getSessionsForVault('vault-b').length, 0);
  });

  it('通用会话（vaultId 显式为 null）任何库都可见', async () => {
    // 显式 null = 「不属于任何库」的普通对话（冷启动种子会话就是这种）——
    // 用户切库不该让它凭空消失。
    const persisted = [{
      id: 'chat:general', title: '通用会话', conversationId: null, mode: 'qa', vaultId: null, filePath: null,
    }];
    const { store } = await freshStore({ persistedSessions: persisted, activeVaultId: 'vault-a' });
    assert.strictEqual(store.getSessions()[0]?.vaultId, null);
    assert.strictEqual(store.getSessionsForVault('vault-a').length, 1);
    assert.strictEqual(store.getSessionsForVault('vault-b').length, 1);
  });

  it('同一 conversation 的去重只在同库内生效', async () => {
    const { store } = await freshStore({ activeVaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'A 会话', conversationId: 'conv-x', vaultId: 'vault-a' });
    // 同一个 conversation 在另一个库 → 不去重，另开一个标签
    const res = store.openSession({ mode: 'qa', title: 'B 会话', conversationId: 'conv-x', vaultId: 'vault-b' });
    assert.strictEqual(res.opened, true);
    assert.strictEqual(store.getSessions().length, 2);
  });

  it('getActiveSessionId 脱离 store 调用也能工作（useSyncExternalStore 会拆方法）', async () => {
    // 踩过的坑：方法体里用 `this` → 被 useSyncExternalStore 当回调传时 this 是
    // undefined → 整页白屏（"Cannot read properties of undefined"）。
    const { store } = await freshStore({ activeVaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'A 会话', conversationId: null });
    const detached = store.getActiveSessionId;
    assert.strictEqual(detached(), store.getSessions()[0]?.id);
  });

  it('关闭会话后，活动会话在本库内另选一个', async () => {
    const { store } = await freshStore({ activeVaultId: 'vault-a' });
    const a1 = store.openSession({ mode: 'qa', title: 'A1', conversationId: null, vaultId: 'vault-a' }).tab!;
    store.openSession({ mode: 'qa', title: 'A2', conversationId: null, vaultId: 'vault-a' });
    store.openSession({ mode: 'qa', title: 'B1', conversationId: null, vaultId: 'vault-b' });

    store.closeSession(a1.id);
    // 活动是 A2（不是 B1 —— 别的库的会话不能当活动）
    assert.strictEqual(store.getActiveSession()?.title, 'A2');
  });
});
