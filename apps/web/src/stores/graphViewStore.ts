/**
 * Graph view active flag — a tiny bridge so the NavRail「图谱」item can highlight
 * when the knowledge-base graph tab is the active view. The KB writes it; NavRail
 * (outside the KB) reads it. Reset on KB unmount.
 */
import { useSyncExternalStore } from 'react';

let active = false;
const listeners = new Set<() => void>();

export const graphViewStore = {
  setActive(v: boolean) {
    if (active === v) return;
    active = v;
    for (const l of listeners) l();
  },
  getActive(): boolean {
    return active;
  },
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};

export function useGraphViewActive(): boolean {
  return useSyncExternalStore(
    graphViewStore.subscribe,
    graphViewStore.getActive,
    graphViewStore.getActive,
  );
}
