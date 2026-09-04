/**
 * Navigation History Store — the order of views the user has visited within
 * the knowledge-base tab workspace: files AND the graph tab.
 *
 * A module-level singleton with useSyncExternalStore React bindings. Session-only
 * (no persistence), capped at 50 entries. back()/forward() walk the stack and
 * delegate the actual open to the registered callbacks — files route through
 * handleSelectFile (activate an existing tab, else recycle the current one, so
 * navigating never grows the tab count); graph entries activate the per-vault
 * graph tab via the registered openGraph callback.
 */

import { useSyncExternalStore } from 'react';

/** A visited view: a file path, or the graph tab (per-vault singleton). */
export type HistoryEntry = { kind: 'file'; path: string } | { kind: 'graph' };

export interface HistorySnapshot {
  canGoBack: boolean;
  canGoForward: boolean;
}

type Listener = () => void;
type OpenFile = (filePath: string) => void;
type OpenGraph = () => void;

// ─── Store state ───

const MAX_ENTRIES = 50;

let entries: HistoryEntry[] = [];
let currentIndex = -1;
const listeners = new Set<Listener>();

// Cached snapshot for useSyncExternalStore referential stability.
let _snapshot: HistorySnapshot = { canGoBack: false, canGoForward: false };
let _openFile: OpenFile | null = null;
let _openGraph: OpenGraph | null = null;

function sameEntry(a: HistoryEntry | undefined, b: HistoryEntry): boolean {
  if (!a) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path;
  return true; // both graph
}

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

  /** back/forward delegate file activation here (KB routes it through handleSelectFile). */
  registerOpenFile(fn: OpenFile) {
    _openFile = fn;
  },

  /** back/forward delegate graph-tab activation here (KB routes it through openGraphTab). */
  registerOpenGraph(fn: OpenGraph) {
    _openGraph = fn;
  },

  /**
   * Record that a view was visited. Deduplicates consecutive identical views,
   * truncates the forward stack, and caps at MAX_ENTRIES. When back/forward
   * activates a view, the resulting activeTab change re-pushes the same entry —
   * which dedups against the current position, so it is not re-recorded.
   */
  push(entry: HistoryEntry) {
    // Dedup: skip if same as the current position.
    if (sameEntry(entries[currentIndex], entry)) return;

    // Truncate forward stack (new branch of history).
    entries = entries.slice(0, currentIndex + 1);
    entries.push(entry);

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
    openEntry(entries[currentIndex]);
  },

  forward() {
    if (currentIndex >= entries.length - 1) return;
    currentIndex++;
    emit();
    openEntry(entries[currentIndex]);
  },

  /** For testing: reset store to initial state. */
  _reset() {
    entries = [];
    currentIndex = -1;
    _openFile = null;
    _openGraph = null;
    listeners.clear();
    _snapshot = recomputeSnapshot();
  },
};

function openEntry(entry: HistoryEntry) {
  if (entry.kind === 'file') {
    _openFile?.(entry.path);
  } else {
    _openGraph?.();
  }
}

// ─── React hook ───

export function useNavigationHistory(): HistorySnapshot {
  return useSyncExternalStore(
    navigationHistoryStore.subscribe,
    navigationHistoryStore.getSnapshot,
    navigationHistoryStore.getSnapshot,
  );
}
