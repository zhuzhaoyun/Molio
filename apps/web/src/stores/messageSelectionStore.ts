/**
 * Selection-mode store for message deletion — mirrors vaultStore's
 * useSyncExternalStore pattern. Per-bubble selectors (useIsSelected) ensure
 * toggling one checkbox only re-renders that bubble + the confirm-bar count,
 * not the whole chat log.
 */
import { useSyncExternalStore } from 'react';
import type { ChatMessage } from '../hooks/useChat';

type Listener = () => void;

let selectMode = false;
let selectedIds: Set<string> = new Set();
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const messageSelectionStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getSelectMode() { return selectMode; },
  getSelectedCount() { return selectedIds.size; },
  isSelected(id: string) { return selectedIds.has(id); },
  getSelectedIds() { return new Set(selectedIds); },

  /** Enter selection mode with the trigger bubble's Q/A pair pre-checked. */
  enterSelection(triggerId: string, messages: ChatMessage[]) {
    const i = messages.findIndex((m) => m.id === triggerId);
    if (i < 0) return;
    const role = messages[i]!.role;
    const pair: string[] = [];
    if (role === 'user') {
      pair.push(messages[i]!.id);
      const next = messages[i + 1];
      if (next && next.role === 'assistant') pair.push(next.id);
    } else if (role === 'assistant') {
      const prev = messages[i - 1];
      if (prev && prev.role === 'user') pair.push(prev.id);
      pair.push(messages[i]!.id);
    } else {
      // error role: no pair, just self
      pair.push(messages[i]!.id);
    }
    selectedIds = new Set(pair);
    selectMode = true;
    emit();
  },

  toggle(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds = next;
    emit();
  },

  exit() {
    if (!selectMode && selectedIds.size === 0) return;
    selectMode = false;
    selectedIds = new Set();
    emit();
  },

  /** Drop selected ids that no longer exist in the present message list. */
  pruneStale(presentIds: Set<string>) {
    if (selectedIds.size === 0) return;
    const next = new Set<string>();
    for (const id of selectedIds) if (presentIds.has(id)) next.add(id);
    if (next.size === selectedIds.size) return; // no change
    selectedIds = next;
    emit();
  },
};

export function useSelectMode(): boolean {
  return useSyncExternalStore(
    messageSelectionStore.subscribe,
    messageSelectionStore.getSelectMode,
    messageSelectionStore.getSelectMode,
  );
}

export function useIsSelected(id: string): boolean {
  return useSyncExternalStore(
    messageSelectionStore.subscribe,
    () => messageSelectionStore.isSelected(id),
    () => messageSelectionStore.isSelected(id),
  );
}

export function useSelectedCount(): number {
  return useSyncExternalStore(
    messageSelectionStore.subscribe,
    messageSelectionStore.getSelectedCount,
    messageSelectionStore.getSelectedCount,
  );
}
