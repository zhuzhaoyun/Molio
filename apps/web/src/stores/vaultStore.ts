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

let activeVaultId: string | null = readPersistedVaultId();
let vaults: Vault[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const vaultStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getActiveVaultId() { return activeVaultId; },

  getVaults() { return vaults; },

  getActiveVault(): Vault | null {
    return vaults.find((v) => v.id === activeVaultId) ?? null;
  },

  setActiveVaultId(id: string | null) {
    if (activeVaultId !== id) {
      activeVaultId = id;
      persistVaultId(id);
      emit();
    }
  },

  setVaults(list: Vault[]) {
    vaults = list;
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
