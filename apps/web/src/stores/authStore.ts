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

function emit() {
  for (const l of listeners) l();
}

export const authStore = {
  subscribe(cb: Listener) {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  },

  getStatus(): AuthStatus | null {
    return status;
  },

  /** Pull the latest snapshot from the daemon. Resolves null on failure. */
  async refresh(): Promise<AuthStatus | null> {
    try {
      const next = await api.getAuthStatus();
      status = next;
      emit();
      return next;
    } catch {
      // daemon 未启动/不可达：保留旧快照（首次则为 null），不打扰用户
      return status;
    }
  },

  /** 登录/登出/注销成功后由调用方触发；等价于 refresh()。 */
  invalidate(): Promise<AuthStatus | null> {
    return this.refresh();
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
