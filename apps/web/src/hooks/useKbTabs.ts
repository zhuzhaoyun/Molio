/**
 * useKbTabs(vaultId) — per-vault KB tab state hook.
 *
 * Creates (via useMemo) a per-vault `createTabsStore(vaultId)` instance so tabs
 * are scoped to the active vault. When vaultId changes (or the component
 * unmounts), the previous store's listeners are released via destroy().
 * State persists to per-vault localStorage keys.
 */

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { createTabsStore, type KbTabsStore, type WorkspaceTab } from '../stores/kbTabsStore';

export type { TabType, WorkspaceTab } from '../stores/kbTabsStore';
export { MAX_TABS } from '../stores/kbTabsStore';

export interface UseKbTabsReturn {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => { opened: boolean; reason?: 'limit' };
  closeTab: (id: string) => void;
  removeWhere: (predicate: (t: WorkspaceTab) => boolean) => string[];
  activateTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  getActiveTab: () => WorkspaceTab | undefined;
}

const NOOP_SUBSCRIBE = () => () => {};

// Referentially stable empty array for the no-vault case. useSyncExternalStore
// requires getSnapshot to return a cached value — a fresh `[]` per call would
// trigger an infinite re-render loop.
const EMPTY_TABS: WorkspaceTab[] = [];

export function useKbTabs(vaultId: string | null): UseKbTabsReturn {
  const store = useMemo<KbTabsStore | null>(() => (vaultId ? createTabsStore(vaultId) : null), [vaultId]);

  // Release the previous vault's store listeners when vaultId changes.
  useEffect(() => () => store?.destroy(), [store]);

  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : NOOP_SUBSCRIBE()), [store]);
  const getTabs = useCallback(() => store?.getTabs() ?? EMPTY_TABS, [store]);
  const getActiveTabId = useCallback(() => store?.getActiveTabId() ?? null, [store]);

  const tabs = useSyncExternalStore(subscribe, getTabs, getTabs);
  const activeTabId = useSyncExternalStore(subscribe, getActiveTabId, getActiveTabId);

  const openTab = useCallback(
    (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => store?.openTab(tab) ?? { opened: false },
    [store],
  );
  const closeTab = useCallback((id: string) => store?.closeTab(id), [store]);
  const removeWhere = useCallback((p: (t: WorkspaceTab) => boolean) => store?.removeWhere(p) ?? [], [store]);
  const activateTab = useCallback((id: string) => store?.activateTab(id), [store]);
  const updateTab = useCallback((id: string, patch: Partial<WorkspaceTab>) => store?.updateTab(id, patch), [store]);
  const getActiveTab = useCallback(() => store?.getActiveTab(), [store]);

  return useMemo(
    () => ({ tabs, activeTabId, openTab, closeTab, removeWhere, activateTab, updateTab, getActiveTab }),
    [tabs, activeTabId, openTab, closeTab, removeWhere, activateTab, updateTab, getActiveTab],
  );
}
