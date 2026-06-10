/**
 * Global KB Tabs Store — persists workspace tabs across page navigation and app restarts.
 *
 * Uses useSyncExternalStore for tear-safe access from any component.
 * State is persisted to localStorage on every change.
 */

import { useSyncExternalStore } from 'react';

const STORAGE_KEY_TABS = 'molio.kb.tabs';
const STORAGE_KEY_ACTIVE_TAB = 'molio.kb.activeTabId';

export type TabType = 'file' | string;

export interface WorkspaceTab {
  id: string;
  type: TabType;
  title: string;
  data?: Record<string, unknown>;
}

type Listener = () => void;

// ─── Persistence helpers ───

function readPersistedTabs(): WorkspaceTab[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TABS);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

function readPersistedActiveTabId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY_ACTIVE_TAB);
  } catch { /* ignore */ }
  return null;
}

function persistState(tabs: WorkspaceTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(STORAGE_KEY_TABS, JSON.stringify(tabs));
    if (activeTabId) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_TAB, activeTabId);
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_TAB);
    }
  } catch { /* storage unavailable */ }
}

// ─── Store state ───

let tabs: WorkspaceTab[] = readPersistedTabs();
let activeTabId: string | null = readPersistedActiveTabId();
const listeners = new Set<Listener>();

function emit() {
  persistState(tabs, activeTabId);
  for (const l of listeners) l();
}

// ─── Store API ───

export const kbTabsStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getTabs() { return tabs; },
  getActiveTabId() { return activeTabId; },

  getActiveTab(): WorkspaceTab | undefined {
    return tabs.find((t) => t.id === activeTabId);
  },

  openTab(tabInput: Omit<WorkspaceTab, 'id'> & { id?: string }) {
    const id = tabInput.id ?? `${tabInput.type}:${Math.random().toString(36).slice(2, 9)}`;
    const existing = tabs.find((t) => t.id === id);
    if (existing) {
      // Already exists — just activate
      if (activeTabId !== id) {
        activeTabId = id;
        emit();
      }
      return;
    }
    const newTab: WorkspaceTab = { ...tabInput, id };
    tabs = [...tabs, newTab];
    activeTabId = id;
    emit();
  },

  closeTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const next = tabs.filter((t) => t.id !== id);
    tabs = next;
    if (activeTabId === id) {
      const newActive = next[idx - 1] ?? next[0] ?? null;
      activeTabId = newActive?.id ?? null;
    }
    emit();
  },

  activateTab(id: string) {
    if (activeTabId !== id) {
      activeTabId = id;
      emit();
    }
  },

  updateTab(id: string, patch: Partial<WorkspaceTab>) {
    let changed = false;
    tabs = tabs.map((t) => {
      if (t.id === id) {
        changed = true;
        return { ...t, ...patch };
      }
      return t;
    });
    if (changed) emit();
  },
};

// ─── React hooks ───

export function useKbTabsData(): WorkspaceTab[] {
  return useSyncExternalStore(
    kbTabsStore.subscribe,
    kbTabsStore.getTabs,
    kbTabsStore.getTabs,
  );
}

export function useKbActiveTabId(): string | null {
  return useSyncExternalStore(
    kbTabsStore.subscribe,
    kbTabsStore.getActiveTabId,
    kbTabsStore.getActiveTabId,
  );
}
