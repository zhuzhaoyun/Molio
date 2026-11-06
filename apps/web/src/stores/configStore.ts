/**
 * Shared app-config store — mirrors daemon `GET /api/config`.
 *
 * Same useSyncExternalStore pattern as authStore/vaultStore. Before this store
 * existed, App.tsx fired THREE independent getConfig() calls (mount, route
 * change, vault change) and gated the whole UI behind `configLoaded` — a white
 * screen until the daemon answered. Now:
 *   - one shared snapshot, refresh() with in-flight dedup (concurrent callers
 *     share one HTTP request);
 *   - refresh() NEVER throws — a down/slow daemon keeps the last snapshot
 *     (null before first success), so the UI renders immediately with
 *     fallbacks instead of blocking on config;
 *   - applyPatch() mirrors successful updateConfig() writes locally so the
 *     snapshot doesn't go stale between refreshes.
 */

import { useSyncExternalStore } from 'react';

export type AppConfigSnapshot = Record<string, unknown>;

type Listener = () => void;

/**
 * Config fetcher — resolved lazily via dynamic import so this module stays
 * loadable in plain node:test (Node cannot resolve the `.js`→`.ts` rewrite of
 * a static `../api/client.js` import). In the Vite build the dynamic import
 * collapses into the existing client chunk; no extra network/parse cost.
 * Tests swap in a stub through __setConfigFetcher().
 */
let fetchConfig = async (): Promise<AppConfigSnapshot> => {
  const { api } = await import('../api/client.js');
  return api.getConfig();
};

/** Test seam — replace the daemon fetcher (node:test has no daemon). */
export function __setConfigFetcher(fn: () => Promise<AppConfigSnapshot>): void {
  fetchConfig = fn;
}

/** null = not yet fetched, or daemon unreachable before the first success. */
let config: AppConfigSnapshot | null = null;
const listeners = new Set<Listener>();
/** In-flight dedup: concurrent refresh() calls share one request. */
let inFlight: Promise<AppConfigSnapshot | null> | null = null;

function emit() {
  for (const l of listeners) l();
}

async function refresh(): Promise<AppConfigSnapshot | null> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const next = await fetchConfig();
      config = next;
      emit();
      return config;
    } catch (err) {
      // daemon 未启动/不可达：保留旧快照（首次则为 null），不阻塞渲染。
      console.warn('[configStore] refresh failed:', err);
      return config;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export const configStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getConfig(): AppConfigSnapshot | null {
    return config;
  },

  /**
   * Pull the latest config from the daemon. Never throws; concurrent calls
   * share one in-flight request. Resolves with the last known snapshot on
   * failure (null only before the first successful fetch).
   */
  refresh(): Promise<AppConfigSnapshot | null> {
    return refresh();
  },

  /**
   * Merge a successful `updateConfig(patch)` into the local snapshot (the
   * daemon PUT is a merge too — see mergeConfig). Keeps the store fresh
   * without an extra round trip; also cancels nothing — a later refresh()
   * still overwrites with server truth.
   */
  applyPatch(patch: AppConfigSnapshot): void {
    config = { ...(config ?? {}), ...patch };
    emit();
  },
};

/** Subscribe to the config snapshot (re-renders when it changes). */
export function useAppConfig(): AppConfigSnapshot | null {
  return useSyncExternalStore(
    configStore.subscribe,
    configStore.getConfig,
    configStore.getConfig,
  );
}
