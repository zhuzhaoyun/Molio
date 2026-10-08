/**
 * vaultStore — active vault selection & persistence.
 *
 * Regression context (2026-10 user report): windows opened with ?vault=
 * (Web Clipper protocol launch, cloned window, "open in new window", graph
 * double-click) initialized activeVaultId from the URL in MEMORY ONLY —
 * the follow-up setActiveVaultId(sameId) short-circuited on the `!==` guard,
 * so localStorage never learned the choice. Next cold start (no URL param)
 * restored a stale vault, and App.tsx's defaultCwd sync effect then mirrored
 * that stale vault back to the daemon — which is also why 微信入库 went to
 * the wrong vault. These tests pin: URL init persists; cold start restores;
 * stale persisted ids fall back to first-vault auto-select.
 *
 * Module state is initialized at import time, so each scenario imports a
 * FRESH instance via a distinct query string (Node ESM treats them as
 * separate modules).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

// node:test 环境没有 localStorage / window —— 注入内存 stub（每个场景重建）
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

const STORAGE_KEY = 'molio.activeVaultId';

interface VaultFixture {
  id: string; name: string; path: string; fileCount: number; createdAt: number;
}
const vault = (id: string): VaultFixture => ({
  id, name: id, path: `/tmp/${id}`, fileCount: 0, createdAt: 1,
});

let scenario = 0;
/** ids passed to the stubbed daemon sync transport (per scenario). */
let syncedIds: Array<string | null> = [];

async function freshStore(opts: { url?: string; persisted?: string } = {}) {
  const storage = new MemStorage();
  if (opts.persisted !== undefined) storage.setItem(STORAGE_KEY, opts.persisted);
  (globalThis as Record<string, unknown>).localStorage = storage;
  (globalThis as Record<string, unknown>).window = {
    location: { search: opts.url ?? '' },
  };
  scenario += 1;
  syncedIds = [];
  const mod = await import(`../src/stores/vaultStore.ts?s=${scenario}`);
  mod.__setActiveVaultSyncer(async (id: string | null) => { syncedIds.push(id); });
  return { store: mod.vaultStore, storage };
}

describe('vaultStore init & persistence', () => {
  it('URL ?vault= init PERSISTS the choice (regression: was memory-only)', async () => {
    const { store, storage } = await freshStore({ url: '?vault=vault-b' });
    assert.strictEqual(store.getActiveVaultId(), 'vault-b');
    assert.strictEqual(
      storage.getItem(STORAGE_KEY), 'vault-b',
      'a window opened with ?vault= must write localStorage, or the next cold start restores a stale vault',
    );
  });

  it('cold start (no URL) restores the persisted vault', async () => {
    const { store } = await freshStore({ persisted: 'vault-a' });
    assert.strictEqual(store.getActiveVaultId(), 'vault-a');
  });

  it('URL wins over stale localStorage and overwrites it', async () => {
    const { store, storage } = await freshStore({ url: '?vault=vault-b', persisted: 'vault-a' });
    assert.strictEqual(store.getActiveVaultId(), 'vault-b');
    assert.strictEqual(storage.getItem(STORAGE_KEY), 'vault-b');
  });

  it('setVaults keeps a valid persisted vault (no clobber by list order)', async () => {
    const { store, storage } = await freshStore({ persisted: 'vault-b' });
    store.setVaults([vault('vault-a'), vault('vault-b')]);
    assert.strictEqual(store.getActiveVaultId(), 'vault-b');
    assert.strictEqual(storage.getItem(STORAGE_KEY), 'vault-b');
  });

  it('setVaults clears a stale persisted id and auto-selects + persists the first vault', async () => {
    const { store, storage } = await freshStore({ persisted: 'deleted-vault' });
    store.setVaults([vault('vault-a'), vault('vault-b')]);
    assert.strictEqual(store.getActiveVaultId(), 'vault-a');
    assert.strictEqual(storage.getItem(STORAGE_KEY), 'vault-a');
  });

  it('URL-initialized store survives the startup setVaults flow', async () => {
    // Full protocol-window boot: module init from ?vault=, then App.tsx's
    // listVaults → setVaults. The URL vault must stay selected & persisted.
    const { store, storage } = await freshStore({ url: '?vault=vault-b' });
    store.setVaults([vault('vault-a'), vault('vault-b')]);
    assert.strictEqual(store.getActiveVaultId(), 'vault-b');
    assert.strictEqual(storage.getItem(STORAGE_KEY), 'vault-b');
  });

  it('setActiveVaultId persists and syncs to the daemon', async () => {
    const { store, storage } = await freshStore({ persisted: 'vault-a' });
    store.setVaults([vault('vault-a'), vault('vault-b')]);
    store.setActiveVaultId('vault-b');
    assert.strictEqual(store.getActiveVaultId(), 'vault-b');
    assert.strictEqual(storage.getItem(STORAGE_KEY), 'vault-b');
    // daemon KV sync (Web Clipper + channel resolveRunCwd follow this)
    const settled = await new Promise<Array<string | null>>((resolve) => {
      setTimeout(() => resolve(syncedIds), 0);
    });
    assert.ok(settled.includes('vault-b'), `expected vault-b synced to daemon, got ${JSON.stringify(settled)}`);
  });
});
