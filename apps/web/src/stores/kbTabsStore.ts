/**
 * Per-Vault KB Tabs Store factory — persists workspace tabs across page
 * navigation and app restarts, scoped to a single vault.
 *
 * Use `createTabsStore(vaultId)` to get a store for a given vault. Each store
 * owns its own state, listeners and localStorage keys
 * (`molio.kb.tabs.<vaultId>` / `molio.kb.activeTabId.<vaultId>`) so multiple
 * windows/vaults never clobber each other.
 *
 * Uses useSyncExternalStore for tear-safe access from any component.
 */

/** Maximum number of simultaneously open document tabs. Cap-only, not configurable. */
export const MAX_TABS = 20;

export type TabType = 'file' | string;

export interface WorkspaceTab {
  id: string;
  type: TabType;
  title: string;
  vaultId?: string;
  data?: Record<string, unknown>;
  /** Pinned tabs are exempt from the load-in-current-tab recycle: they keep
   *  their document until explicitly unpinned. Persisted with the tab. */
  pinned?: boolean;
}

export type Listener = () => void;

// ─── Persistence helpers (keyed per vault) ───

/** Pre-multi-window global keys (previous release) — migrated once on first read. */
const LEGACY_TABS_KEY = 'molio.kb.tabs';
const LEGACY_ACTIVE_KEY = 'molio.kb.activeTabId';

function readPersistedTabs(storageKey: string): WorkspaceTab[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return [];
}

/**
 * Migrate the pre-multi-window global tab keys into this vault's per-vault
 * keys. The previous release persisted `molio.kb.tabs` / `molio.kb.activeTabId`
 * globally; those keys are now orphaned, so without this an upgrading user
 * silently loses their open-tab layout.
 *
 * Runs exactly once per vault: only when the per-vault key is absent AND the
 * legacy key exists. After migrating, the legacy keys are removed so a second
 * window / reload never re-migrates. Returns the migrated state, or null when
 * there is nothing to migrate (malformed legacy data is left untouched).
 *
 * A migrated `WorkspaceTab` may lack a `vaultId` field — that is fine. KB-page
 * logic that filters `t.vaultId === activeVault.id` (e.g. stale-tab cleanup)
 * simply skips untagged tabs, and because the store is per-vault now they still
 * show in this window.
 */
function migrateLegacyTabs(tabsKey: string, activeKey: string): { tabs: WorkspaceTab[]; activeTabId: string | null } | null {
  try {
    if (localStorage.getItem(tabsKey) != null) return null; // per-vault data already present
    const rawLegacy = localStorage.getItem(LEGACY_TABS_KEY);
    if (rawLegacy == null) return null; // no legacy data
    const legacyTabs = JSON.parse(rawLegacy) as WorkspaceTab[];
    if (!Array.isArray(legacyTabs)) return null;
    const legacyActive = readPersistedActiveTabId(LEGACY_ACTIVE_KEY);
    localStorage.setItem(tabsKey, JSON.stringify(legacyTabs));
    if (legacyActive) localStorage.setItem(activeKey, legacyActive);
    else localStorage.removeItem(activeKey);
    localStorage.removeItem(LEGACY_TABS_KEY);
    localStorage.removeItem(LEGACY_ACTIVE_KEY);
    return { tabs: legacyTabs, activeTabId: legacyActive };
  } catch { /* storage unavailable / malformed JSON — leave keys for a later attempt */ }
  return null;
}

function readPersistedActiveTabId(storageKey: string): string | null {
  try {
    return localStorage.getItem(storageKey);
  } catch { /* ignore */ }
  return null;
}

function persistState(tabsKey: string, activeKey: string, tabs: WorkspaceTab[], activeTabId: string | null) {
  try {
    localStorage.setItem(tabsKey, JSON.stringify(tabs));
    if (activeTabId) localStorage.setItem(activeKey, activeTabId);
    else localStorage.removeItem(activeKey);
  } catch { /* storage unavailable */ }
}

// ─── Factory ───

export interface KbTabsStore {
  subscribe(cb: Listener): () => void;
  getTabs(): WorkspaceTab[];
  getActiveTabId(): string | null;
  getActiveTab(): WorkspaceTab | undefined;
  openTab(tab: Omit<WorkspaceTab, 'id'> & { id?: string }): { opened: boolean; reason?: 'limit' };
  closeTab(id: string): void;
  removeWhere(predicate: (t: WorkspaceTab) => boolean): string[];
  activateTab(id: string): void;
  updateTab(id: string, patch: Partial<WorkspaceTab>): void;
  /** Toggle a tab's pinned flag in place. */
  togglePin(id: string): void;
  /** Release listeners when the owning window/vault store is unmounted. */
  destroy(): void;
}

export function createTabsStore(vaultId: string): KbTabsStore {
  const tabsKey = `molio.kb.tabs.${vaultId}`;
  const activeKey = `molio.kb.activeTabId.${vaultId}`;
  const migrated = migrateLegacyTabs(tabsKey, activeKey);
  let tabs: WorkspaceTab[] = migrated?.tabs ?? readPersistedTabs(tabsKey);
  let activeTabId: string | null = migrated ? migrated.activeTabId : readPersistedActiveTabId(activeKey);
  const listeners = new Set<Listener>();

  function emit() {
    persistState(tabsKey, activeKey, tabs, activeTabId);
    for (const l of listeners) l();
  }

  return {
    subscribe(cb: Listener) {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },

    getTabs() { return tabs; },
    getActiveTabId() { return activeTabId; },

    getActiveTab(): WorkspaceTab | undefined {
      return tabs.find((t) => t.id === activeTabId);
    },

    openTab(tabInput: Omit<WorkspaceTab, 'id'> & { id?: string }): { opened: boolean; reason?: 'limit' } {
      const id = tabInput.id ?? `${tabInput.type}:${Math.random().toString(36).slice(2, 9)}`;
      const existing = tabs.find((t) => t.id === id);
      if (existing) {
        if (activeTabId !== id) {
          activeTabId = id;
          emit();
        }
        return { opened: false };
      }
      if (tabs.length >= MAX_TABS) {
        return { opened: false, reason: 'limit' };
      }
      const newTab: WorkspaceTab = { ...tabInput, id };
      tabs = [...tabs, newTab];
      activeTabId = id;
      emit();
      return { opened: true };
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

    removeWhere(predicate: (t: WorkspaceTab) => boolean): string[] {
      const removed = tabs.filter(predicate);
      if (removed.length === 0) return [];
      const removedIds = new Set(removed.map((t) => t.id));
      const survivors = tabs.filter((t) => !removedIds.has(t.id));
      tabs = survivors;
      if (activeTabId && removedIds.has(activeTabId)) {
        activeTabId = survivors[0]?.id ?? null;
      }
      emit();
      return removed.map((t) => t.id);
    },

    activateTab(id: string) {
      if (!tabs.some((t) => t.id === id)) return;
      if (activeTabId !== id) {
        activeTabId = id;
        emit();
      }
    },

    updateTab(id: string, patch: Partial<WorkspaceTab>) {
      let changed = false;
      const newId = patch.id;
      tabs = tabs.map((t) => {
        if (t.id === id) {
          changed = true;
          return { ...t, ...patch };
        }
        return t;
      });
      if (changed && newId && activeTabId === id && id !== newId) {
        activeTabId = newId;
      }
      if (changed) emit();
    },

    togglePin(id: string) {
      let changed = false;
      tabs = tabs.map((t) => {
        if (t.id === id) {
          changed = true;
          return { ...t, pinned: !t.pinned };
        }
        return t;
      });
      if (changed) emit();
    },

    destroy() { listeners.clear(); },
  };
}
