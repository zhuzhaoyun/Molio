/**
 * 通用工作区标签页状态管理 hook
 * Obsidian-style tab system — 文件、Wiki、设置等都可作为 tab 打开
 */

import { useState, useCallback, useMemo } from 'react';

export type TabType = 'file' | string;

export interface WorkspaceTab {
  id: string; // 唯一标识（如 file:notes/intro.md）
  type: TabType; // tab 类型
  title: string; // 显示标题
  data?: Record<string, unknown>; // 类型特定的数据
}

export interface UseKbTabsReturn {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: Omit<WorkspaceTab, 'id'> & { id?: string }) => void;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  updateTab: (id: string, patch: Partial<WorkspaceTab>) => void;
  getActiveTab: () => WorkspaceTab | undefined;
}

export function useKbTabs(): UseKbTabsReturn {
  const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const openTab = useCallback((tabInput: Omit<WorkspaceTab, 'id'> & { id?: string }) => {
    const id = tabInput.id ?? `${tabInput.type}:${Math.random().toString(36).slice(2, 9)}`;

    setTabs((prev) => {
      const existing = prev.find((t) => t.id === id);
      if (existing) {
        // 已存在则激活
        setActiveTabId(id);
        return prev;
      }
      const newTab: WorkspaceTab = { ...tabInput, id };
      return [...prev, newTab];
    });
    setActiveTabId(id);
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== id);
      // 关闭活跃 tab 时，自动激活前一个
      if (activeTabId === id) {
        const newActive = next[idx - 1] ?? next[0] ?? null;
        setActiveTabId(newActive?.id ?? null);
      }
      return next;
    });
  }, [activeTabId]);

  const activateTab = useCallback((id: string) => {
    setActiveTabId(id);
  }, []);

  const updateTab = useCallback((id: string, patch: Partial<WorkspaceTab>) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
    );
  }, []);

  const getActiveTab = useCallback(() => {
    return tabs.find((t) => t.id === activeTabId);
  }, [tabs, activeTabId]);

  return useMemo(
    () => ({
      tabs,
      activeTabId,
      openTab,
      closeTab,
      activateTab,
      updateTab,
      getActiveTab,
    }),
    [tabs, activeTabId, openTab, closeTab, activateTab, updateTab, getActiveTab]
  );
}
