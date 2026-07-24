import type { FeishuApi } from './client.js';
import type { FeishuCredentials } from './types.js';
import type { FeishuConfig } from '../config.js';
import {
  readCredentials as readCredFile,
  resolveCredentialsPath as resolveCredsPath,
  writeCredentials,
} from '../channels/credentials-store.js';

const FEISHU_CHANNEL_PREFIX = 'feishu';
/** Refresh cadence: tenant_access_token is 2h valid; refresh at ~100min. */
const DEFAULT_REFRESH_INTERVAL_MS = 100 * 60 * 1000;

export interface FeishuTokenStoreDeps {
  /**
   * Returns the live FeishuApi instance. The api is constructed in `start()`
   * AFTER the tokenStore is created (so we can't pass it as a constructor
   * param), so the store reads it lazily on each getToken()/refresh call.
   */
  getApi: () => FeishuApi | null;
  /** Read the latest FeishuConfig — used to resolve the credentials file path. */
  getConfig: () => FeishuConfig;
  /**
   * Surface a non-fatal error (e.g. token write failure) to the channel's
   * status.lastError field. Token fetch failures still throw — the caller
   * (start / send / download) decides whether to abort the operation.
   */
  onPersistError?: (msg: string) => void;
  /** Refresh interval override (defaults to 100min). */
  refreshIntervalMs?: number;
}

/**
 * Owns the tenant_access_token lifecycle: in-memory cache + on-disk
 * persistence (~/.molio/feishu-credentials.json) + periodic refresh timer.
 *
 * Extracted from FeishuService so the 538-line service.ts can shed token
 * bookkeeping — the store encapsulates the three-step flow (cache → disk →
 * fetch) so callers just call `getToken()`.
 *
 * The store does NOT own the FeishuApi instance (it's constructed in
 * `FeishuService.start()` after the store). It reads the api lazily via
 * `getApi()` on each call. This avoids a circular dependency where the api
 * needs appId/appSecret (from config, only available after start) but the
 * store would need the api in its constructor.
 */
export class FeishuTokenStore {
  private cachedToken: FeishuCredentials | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: FeishuTokenStoreDeps;
  private readonly refreshIntervalMs: number;

  constructor(deps: FeishuTokenStoreDeps) {
    this.deps = deps;
    this.refreshIntervalMs = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /**
   * Return a usable tenant_access_token. Resolution order:
   *  1. In-memory cache (if still valid)
   *  2. On-disk credentials (if still valid) — populated by a prior daemon run
   *  3. Fetch fresh from Feishu API — and persist to disk before caching
   *
   * Throws if the fetch fails (caller surfaces to status). A write failure
   * surfaces to onPersistError AND re-throws so the caller knows the token
   * wasn't persisted (a subsequent restart would lose it).
   */
  async getToken(): Promise<string> {
    const api = this.deps.getApi();
    if (!api) throw new Error('FeishuApi not initialized');

    const cached = this.cachedToken ?? this.readFromDisk();
    if (cached && api.isTokenValid(cached)) {
      this.cachedToken = cached;
      return cached.tenantAccessToken;
    }

    const refreshed = await api.fetchTenantAccessToken();
    // Persist BEFORE updating the in-memory cache so a write failure doesn't
    // leave the cache ahead of what's on disk (a restart would lose the token).
    try {
      this.writeToDisk(refreshed);
    } catch (err) {
      this.deps.onPersistError?.(
        `Token 写盘失败：${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    this.cachedToken = refreshed;
    return refreshed.tenantAccessToken;
  }

  /**
   * Drop the in-memory cache (e.g. when appId/appSecret changed, the old
   * token belongs to a different app). The next getToken() will hit disk
   * (likely missing too after removeCredentials) and re-fetch.
   */
  invalidate(): void {
    this.cachedToken = null;
  }

  /** Start the periodic refresh timer. Idempotent — calling twice resets. */
  startRefresh(): void {
    this.stopRefresh();
    this.refreshTimer = setInterval(() => {
      void this.refreshSafe();
    }, this.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  /** Stop the periodic refresh timer. Idempotent. */
  stopRefresh(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshSafe(): Promise<void> {
    const api = this.deps.getApi();
    if (!api) return;
    try {
      const fresh = await api.fetchTenantAccessToken();
      try {
        this.writeToDisk(fresh);
      } catch (err) {
        this.deps.onPersistError?.(
          `Token 写盘失败：${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      this.cachedToken = fresh;
    } catch (err) {
      // Don't tear down anything — caller's WS keeps trying; surface the error.
      this.deps.onPersistError?.(
        `Token 刷新失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private resolvePath(): string {
    return resolveCredsPath(this.deps.getConfig().credentialsPath, FEISHU_CHANNEL_PREFIX);
  }

  private readFromDisk(): FeishuCredentials | null {
    return readCredFile<FeishuCredentials>(this.resolvePath(), (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Partial<FeishuCredentials>;
      if (typeof r.tenantAccessToken !== 'string' || !r.tenantAccessToken) return null;
      if (typeof r.expiresAt !== 'number' || !r.expiresAt) return null;
      return { tenantAccessToken: r.tenantAccessToken, expiresAt: r.expiresAt };
    });
  }

  private writeToDisk(creds: FeishuCredentials): void {
    writeCredentials(this.resolvePath(), creds);
  }
}
