/**
 * Shared vault store — single source of truth for active vault selection.
 *
 * Uses React 18's useSyncExternalStore for tear-safe external store access.
 * Both App.tsx (chat cwd) and useKnowledge (KB page) read/write the same state.
 */

import { useSyncExternalStore } from 'react';
import type { Vault } from '@molio/contracts';

type Listener = () => void;

const STORAGE_KEY = 'molio.activeVaultId';

/** Read persisted vault ID from localStorage (returns null on error). */
function readPersistedVaultId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Read ?vault= from the window URL — the per-window authoritative vault.
 * Each BrowserWindow / browser tab is a separate renderer, so this module-level
 * read is per-window. Fresh loads of /knowledge?vault=X initialize straight to X.
 */
function readUrlVaultId(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('vault');
  } catch {
    return null;
  }
}

/** Persist vault ID to localStorage. */
function persistVaultId(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(STORAGE_KEY, id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* storage unavailable */ }
}

const initialUrlVaultId = readUrlVaultId();
let activeVaultId: string | null = initialUrlVaultId ?? readPersistedVaultId();
// A window opened with ?vault= (protocol launch from the Web Clipper, cloned
// window, "open in new window", graph double-click) must also PERSIST that
// choice. It used to live in memory only: the follow-up setActiveVaultId(sameId)
// from KnowledgeBasePage's URL→store effect short-circuits on the `!==` guard,
// so persistVaultId never ran — and the next cold start (no URL param) restored
// a stale localStorage vault instead of the one the user actually closed the app
// on (2026-10 user report: "重启后永远打开最初那个 vault").
if (initialUrlVaultId) persistVaultId(initialUrlVaultId);
let vaults: Vault[] = [];
/**
 * 库列表是否已从 daemon 取回过。首帧 `vaults` 也是空数组，跟「真有 0 个库」
 * 无法区分——没有这个标志，首次运行引导会在已装好库的用户面前闪一下。
 * 取数失败时保持 false（宁可不出引导，也不能对着有库的人说「你还没建库」）。
 */
let vaultsLoaded = false;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

/**
 * Push the current active vault id to the daemon so external clients
 * (e.g. the Molio-forked Web Clipper) can follow "save to the open vault",
 * and channel runs (weixin/feishu resolveRunCwd) inherit the selection.
 * Fire-and-forget — failing to sync is non-fatal (UI keeps working locally).
 *
 * Test seam: the default impl dynamically imports api/client (unreachable
 * under plain node:test); tests swap in a stub via __setActiveVaultSyncer —
 * same pattern as configStore's __setConfigFetcher.
 */
let activeVaultSyncer: (id: string | null) => Promise<void> = async (id) => {
  const { api } = await import('../api/client.js');
  return api.setActiveVault(id);
};

/** @internal test-only: replace the daemon sync transport. */
export function __setActiveVaultSyncer(fn: (id: string | null) => Promise<void>): void {
  activeVaultSyncer = fn;
}

function syncActiveVaultToServer(id: string | null): void {
  void activeVaultSyncer(id).catch((err) => {
    // Swallow: the daemon may be down or unreachable; localStorage still holds
    // the source of truth for the UI.
    console.warn('[vaultStore] failed to sync active vault to daemon:', err);
  });
}

export const vaultStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getActiveVaultId() { return activeVaultId; },

  getVaults() { return vaults; },

  getVaultsLoaded() { return vaultsLoaded; },

  getActiveVault(): Vault | null {
    return vaults.find((v) => v.id === activeVaultId) ?? null;
  },

  setActiveVaultId(id: string | null) {
    if (activeVaultId !== id) {
      activeVaultId = id;
      persistVaultId(id);
      emit();
      syncActiveVaultToServer(id);
    }
  },

  setVaults(list: Vault[]) {
    vaults = list;
    vaultsLoaded = true;
    // If persisted vault is still in the list, keep it
    if (activeVaultId && !list.some((v) => v.id === activeVaultId)) {
      // Persisted vault no longer exists — clear and fall through to auto-select
      activeVaultId = null;
      persistVaultId(null);
    }
    // Auto-select first vault only if nothing is selected
    if (!activeVaultId && list.length > 0 && list[0]) {
      activeVaultId = list[0].id;
      persistVaultId(activeVaultId);
    }
    emit();
    // Sync the resolved id to the daemon so external clients (Web Clipper)
    // follow the user's selection. Idempotent — safe to call on every refresh.
    syncActiveVaultToServer(activeVaultId);
  },
};

/** Subscribe to the active vault (re-renders when it changes). */
export function useActiveVault(): Vault | null {
  return useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getActiveVault,
    vaultStore.getActiveVault,
  );
}

/** Subscribe to the active vault ID only. */
export function useActiveVaultId(): string | null {
  return useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getActiveVaultId,
    vaultStore.getActiveVaultId,
  );
}

/** Subscribe to the full vault list (identity-stable — replaced on setVaults). */
export function useVaults(): Vault[] {
  return useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getVaults,
    vaultStore.getVaults,
  );
}

/** Subscribe to "库列表已取回" —— 用于区分「还没加载」和「真的一个都没有」。 */
export function useVaultsLoaded(): boolean {
  return useSyncExternalStore(
    vaultStore.subscribe,
    vaultStore.getVaultsLoaded,
    vaultStore.getVaultsLoaded,
  );
}
