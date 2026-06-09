/**
 * Shared vault store — single source of truth for active vault selection.
 *
 * Uses React 18's useSyncExternalStore for tear-safe external store access.
 * Both App.tsx (chat cwd) and useKnowledge (KB page) read/write the same state.
 */

import { useSyncExternalStore } from 'react';
import type { Vault } from '@molio/contracts';

type Listener = () => void;

let activeVaultId: string | null = null;
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
      emit();
    }
  },

  setVaults(list: Vault[]) {
    vaults = list;
    // Auto-select first vault if nothing is selected yet
    if (!activeVaultId && list.length > 0 && list[0]) {
      activeVaultId = list[0].id;
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
