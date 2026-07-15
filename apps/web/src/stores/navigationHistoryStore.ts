/**
 * Navigation History Store — tracks page routes and file opens for forward/back navigation.
 *
 * Module-level singleton with useSyncExternalStore React bindings.
 * Session-only (no persistence). Capped at 50 entries.
 */

import { useSyncExternalStore } from 'react';

// ─── Types ───

export interface NavEntry {
  type: 'route' | 'file';
  route: string;
  filePath?: string;
  vaultId?: string;
  label: string;
}

interface HistorySnapshot {
  canGoBack: boolean;
  canGoForward: boolean;
  currentLabel: string;
  backLabel: string;
  forwardLabel: string;
}

type Listener = () => void;

// ─── Store state ───

const MAX_ENTRIES = 50;

let entries: NavEntry[] = [];
let currentIndex = -1;
let _suppressCount = 0;
let _suppressTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function _scheduleSuppressReset() {
  if (_suppressTimer) clearTimeout(_suppressTimer);
  _suppressTimer = setTimeout(() => { _suppressCount = 0; _suppressTimer = null; }, 1000);
}

// Cached snapshot for useSyncExternalStore referential stability
let _snapshot: HistorySnapshot;

function recomputeSnapshot() {
  const current = entries[currentIndex];
  _snapshot = {
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < entries.length - 1,
    currentLabel: current?.label ?? '',
    backLabel: currentIndex > 0 ? entries[currentIndex - 1].label : '',
    forwardLabel: currentIndex < entries.length - 1 ? entries[currentIndex + 1].label : '',
  };
}

recomputeSnapshot();

// Registered execution callbacks
let _navigate: ((to: string, opts?: { replace?: boolean }) => void) | null = null;
let _openFile: ((vaultId: string, filePath: string) => void) | null = null;

function emit() {
  recomputeSnapshot();
  for (const l of listeners) l();
}

function getSnapshot(): HistorySnapshot {
  return _snapshot;
}

// ─── Store API ───

export const navigationHistoryStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getSnapshot,

  registerNavigator(fn: typeof _navigate) {
    _navigate = fn;
  },

  registerFileOpener(fn: typeof _openFile) {
    _openFile = fn;
  },

  /**
   * Set the number of subsequent push() calls to suppress.
   * Used by registered callbacks to prevent back/forward-driven
   * navigations from being re-recorded in history.
   *
   * Route-only back/forward: suppress 1 (the route-change push in App.tsx).
   * File back/forward (same-page): suppress 1 (the handleSelectFile push).
   * File back/forward (cross-page): suppress 2 (route-change + handleSelectFile).
   */
  setSuppressCount(n: number) {
    _suppressCount = n;
    if (n > 0) _scheduleSuppressReset();
  },

  /**
   * Push a new entry onto the history stack.
   * Truncates forward stack, deduplicates consecutive identical entries,
   * and caps at MAX_ENTRIES. Respects _suppressCount for back/forward-driven
   * navigations (back to route = 1 suppression, back to file = 2 suppressions
   * to cover both route change + file open).
   */
  push(entry: NavEntry) {
    if (_suppressCount > 0) {
      _suppressCount--;
      if (_suppressCount === 0 && _suppressTimer) {
        clearTimeout(_suppressTimer);
        _suppressTimer = null;
      }
      return;
    }

    // Truncate forward stack (new branch)
    entries = entries.slice(0, currentIndex + 1);

    // Dedup: skip if same as current position
    const current = entries[currentIndex];
    if (current) {
      const sameType = current.type === entry.type;
      const sameRoute = current.route === entry.route;
      const sameFile = current.filePath === entry.filePath;
      if (sameType && sameRoute && sameFile) return;
    }

    entries.push(entry);

    // Cap at MAX_ENTRIES (drop oldest)
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(entries.length - MAX_ENTRIES);
    }

    currentIndex = entries.length - 1;
    emit();
  },

  back() {
    if (currentIndex <= 0) return;
    currentIndex--;
    emit();

    const entry = entries[currentIndex];
    if (entry.type === 'route') {
      _suppressCount = 1; // suppress the route-change push in App.tsx
      _scheduleSuppressReset();
      _navigate?.(entry.route);
    } else if (entry.type === 'file' && entry.vaultId && entry.filePath) {
      // File opener sets suppressCount based on whether it needs a route change
      _openFile?.(entry.vaultId, entry.filePath);
    }
  },

  forward() {
    if (currentIndex >= entries.length - 1) return;
    currentIndex++;
    emit();

    const entry = entries[currentIndex];
    if (entry.type === 'route') {
      _suppressCount = 1;
      _scheduleSuppressReset();
      _navigate?.(entry.route);
    } else if (entry.type === 'file' && entry.vaultId && entry.filePath) {
      // File opener sets suppressCount based on whether it needs a route change
      _openFile?.(entry.vaultId, entry.filePath);
    }
  },

  /** For testing: reset store to initial state. */
  _reset() {
    entries = [];
    currentIndex = -1;
    _suppressCount = 0;
    if (_suppressTimer) { clearTimeout(_suppressTimer); _suppressTimer = null; }
    _navigate = null;
    _openFile = null;
    listeners.clear();
    recomputeSnapshot();
  },
};

// ─── React hook ───

export function useNavigationHistory(): HistorySnapshot {
  return useSyncExternalStore(
    navigationHistoryStore.subscribe,
    navigationHistoryStore.getSnapshot,
    navigationHistoryStore.getSnapshot,
  );
}
