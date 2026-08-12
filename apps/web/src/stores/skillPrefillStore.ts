/**
 * Shared "save as skill" prefill store.
 *
 * The "存为技能" button lives on each assistant message (deep in the chat tree),
 * but the confirmation modal must render at the app root (above the chat). Rather
 * than prop-drill a callback through ChatPane → AssistantMessage → App, the button
 * pushes a PrefillResult here and App.tsx subscribes and renders the modal.
 *
 * Uses React 18's useSyncExternalStore for tear-free external store access,
 * same pattern as vaultStore / messageSelectionStore.
 */

import { useSyncExternalStore } from 'react';
import type { PrefillResult } from '@molio/contracts';

type Listener = () => void;

let pendingPrefill: PrefillResult | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l();
}

export const skillPrefillStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getPendingPrefill() { return pendingPrefill; },

  setPendingPrefill(prefill: PrefillResult | null) {
    pendingPrefill = prefill;
    emit();
  },
};

/** Subscribe to the pending prefill (re-renders when it changes). */
export function usePendingPrefill(): PrefillResult | null {
  return useSyncExternalStore(
    skillPrefillStore.subscribe,
    skillPrefillStore.getPendingPrefill,
    skillPrefillStore.getPendingPrefill,
  );
}
