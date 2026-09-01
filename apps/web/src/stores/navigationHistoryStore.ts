/**
 * Navigation History Store — the order of files the user has viewed within the
 * knowledge-base tab workspace.
 *
 * A module-level singleton with useSyncExternalStore React bindings. Session-only
 * (no persistence), capped at 50 entries. back()/forward() walk the stack and
 * delegate the actual file open to the registered openFile callback — which the
 * KB routes through handleSelectFile (activate an existing tab, else recycle the
 * current one), so navigating never grows the tab count.
 */

import { useSyncExternalStore } from 'react';

export interface HistorySnapshot {
  canGoBack: boolean;
  canGoForward: boolean;
}

type Listener = () => void;
type OpenFile = (filePath: string) => void;

// ─── Store state ───

const MAX_ENTRIES = 50;

let entries: string[] = [];
let currentIndex = -1;
const listeners = new Set<Listener>();

// Cached snapshot for useSyncExternalStore referential stability.
let _snapshot: HistorySnapshot = { canGoBack: false, canGoForward: false };
let _openFile: OpenFile | null = null;

function recomputeSnapshot(): HistorySnapshot {
  return {
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex < entries.length - 1,
  };
}

function emit() {
  _snapshot = recomputeSnapshot();
  for (const l of listeners) l();
}

function getSnapshot(): HistorySnapshot {
  return _snapshot;
}

// ─── Store API ───

export const navigationHistoryStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },

  getSnapshot,

  /** back/forward delegate tab activation here. */
  registerOpenFile(fn: OpenFile) {
    _openFile = fn;
  },

  /**
   * Record that a file was viewed. Deduplicates consecutive identical files,
   * truncates the forward stack, and caps at MAX_ENTRIES. When back/forward
   * activates a tab, the resulting activeTab change re-pushes the same file —
   * which dedups against the current position, so it is not re-recorded.
   */
  push(filePath: string) {
    // Dedup: skip if same as the current position.
    const current = entries[currentIndex];
    if (current === filePath) return;

    // Truncate forward stack (new branch of history).
    entries = entries.slice(0, currentIndex + 1);
    entries.push(filePath);

    // Cap at MAX_ENTRIES (drop oldest).
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
    _openFile?.(entries[currentIndex]);
  },

  forward() {
    if (currentIndex >= entries.length - 1) return;
    currentIndex++;
    emit();
    _openFile?.(entries[currentIndex]);
  },

  /** For testing: reset store to initial state. */
  _reset() {
    entries = [];
    currentIndex = -1;
    _openFile = null;
    listeners.clear();
    _snapshot = recomputeSnapshot();
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
