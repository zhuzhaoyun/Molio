/**
 * useKbTabs hook — thin wrapper around the global kbTabsStore.
 *
 * State lives in a module-level store (not component state), so it survives
 * component unmount / remount during route navigation and persists to
 * localStorage for app restart recovery.
 */

import { useCallback, useMemo } from 'react';
import {
  kbTabsStore,
  useKbTabsData,
  useKbActiveTabId,
  type WorkspaceTab,
} from '../stores/kbTabsStore';

export type { TabType, WorkspaceTab } from '../stores/kbTabsStore';
export { MAX_TABS } from '../stores/kbTabsStore';

export interface UseKbTabsReturn {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => { opened: boolean; reason?: 'limit' };
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  getActiveTab: () => WorkspaceTab | undefined;
}

export function useKbTabs(): UseKbTabsReturn {
  const tabs = useKbTabsData();
  const activeTabId = useKbActiveTabId();

  const openTab = useCallback(
    (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => kbTabsStore.openTab(tab),
    [],
  );

  const closeTab = useCallback(
    (id: string) => kbTabsStore.closeTab(id),
    [],
  );

  const activateTab = useCallback(
    (id: string) => kbTabsStore.activateTab(id),
    [],
  );

  const updateTab = useCallback(
    (id: string, patch: Partial<WorkspaceTab>) => kbTabsStore.updateTab(id, patch),
    [],
  );

  const getActiveTab = useCallback(
    () => kbTabsStore.getActiveTab(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabs, activeTabId],
  );

  return useMemo(
    () => ({ tabs, activeTabId, openTab, closeTab, activateTab, updateTab, getActiveTab }),
    [tabs, activeTabId, openTab, closeTab, activateTab, updateTab, getActiveTab],
  );
}
