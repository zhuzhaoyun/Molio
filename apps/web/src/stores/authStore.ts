/**
 * Shared auth store — login state snapshot from daemon `GET /api/auth/status`.
 *
 * Same useSyncExternalStore pattern as vaultStore. The daemon is the source of
 * truth (it holds the tokens); this store only mirrors its snapshot for UI
 * rendering. `refresh()` never throws — a down daemon keeps the last known
 * state (local-first: auth UI degrades, never blocks).
 */

import { useSyncExternalStore } from 'react';
import type { AuthStatus } from '@molio/contracts';
import { api } from '../api/client.js';

type Listener = () => void;

/** null = not yet fetched (initial load) or daemon unreachable before first fetch. */
let status: AuthStatus | null = null;
const listeners = new Set<Listener>();
/**
 * Monotonic refresh sequence — concurrent refresh() calls (30s poll + focus +
 * invalidate racing each other) can resolve out of order; only the newest
 * request may write the snapshot, otherwise a slow stale response overwrites
 * a fresh one (e.g. logout status clobbered by an older logged-in reply).
 */
let refreshSeq = 0;

function emit() {
  for (const l of listeners) l();
}

async function refresh(): Promise<AuthStatus | null> {
  const seq = ++refreshSeq;
  let next: AuthStatus;
  try {
    next = await api.getAuthStatus();
  } catch (err) {
    // daemon 未启动/不可达：保留旧快照（首次则为 null），不打扰用户。
    // 留一条 warn（同 vaultStore 模式）：30s 轮询下持续不可达若无任何日志，
    // 登录态问题将完全无从排查。
    console.warn('[authStore] refresh failed:', err);
    return status;
  }
  if (seq !== refreshSeq) return status; // superseded by a newer refresh
  status = next;
  emit();
  return next;
}

export const authStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getStatus(): AuthStatus | null {
    return status;
  },

  /**
   * Pull the latest snapshot from the daemon. Never throws — resolves with
   * the last known status on failure (null only before the first successful
   * fetch), and drops responses superseded by a newer refresh.
   */
  refresh(): Promise<AuthStatus | null> {
    return refresh();
  },

  /** 登录/登出/注销成功后由调用方触发；等价于 refresh()。 */
  invalidate(): Promise<AuthStatus | null> {
    return refresh();
  },
};

/** Subscribe to the auth status snapshot (re-renders when it changes). */
export function useAuthStatus(): AuthStatus | null {
  return useSyncExternalStore(
    authStore.subscribe,
    authStore.getStatus,
    authStore.getStatus,
  );
}
