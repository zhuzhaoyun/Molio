/**
 * 通用工作区标签页状态管理 hook
 * Obsidian-style tab system — 文件、Wiki、设置等都可作为 tab 打开
 *
 * 状态持久化到 localStorage，支持跨页面/重启恢复
 */

import { useState, useCallback, useMemo, useEffect } from 'react';

const STORAGE_KEY_TABS = 'molio.kb.tabs';
const STORAGE_KEY_ACTIVE_TAB = 'molio.kb.activeTabId';

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

/** 从 localStorage 读取持久化的标签状态 */
function readPersistedTabs(): WorkspaceTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TABS);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

/** 从 localStorage 读取持久化的活跃标签 ID */
function readPersistedActiveTabId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_TAB);
  } catch { /* ignore */ }
  return null;
}

/** 持久化标签状态到 localStorage */
function persistTabs(tabs: WorkspaceTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(tabs));
    if (activeTabId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_TAB, activeTabId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_TAB);
    }
  } catch { /* storage unavailable */ }
}

export function useKbTabs(): UseKbTabsReturn {
  const [tabs, setTabs] = useState<WorkspaceTab[]>(readPersistedTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(readPersistedActiveTabId);

  // 每次状态变化时持久化
  useEffect(() => {
    persistTabs(tabs, activeTabId);
  }, [tabs, activeTabId]);

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
      setActiveTabId((currentActive) => {
        if (currentActive === id) {
          const newActive = next[idx - 1] ?? next[0] ?? null;
          return newActive?.id ?? null;
        }
        return currentActive;
      });
      return next;
    });
  }, []);

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
