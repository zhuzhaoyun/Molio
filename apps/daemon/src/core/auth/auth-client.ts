import type {
  AuthStatus,
  MeResponse,
  RefreshResponse,
  SendCodeResponse,
  User,
  VerifyResponse,
} from '@molio/contracts';
import {
  clearAuthTokens,
  decodeAccessExp,
  readAuthTokens,
  writeAuthTokens,
  type AuthTokens,
} from './token-store.js';
import { EntitlementCache } from './entitlement-cache.js';

/** 云端地址 env：未设置时登录相关端点回 503 auth_not_configured（域名备案完成前无默认值）。 */
export const AUTH_URL_ENV = 'MOLIO_AUTH_URL';

/** access 剩余寿命 <2min 主动刷新（设计 §7.2），避免请求中途失败。 */
export const PROACTIVE_REFRESH_MS = 2 * 60 * 1000;

/** 网络错误退避延迟（ms）。4xx 不重试；5xx/断网重试。 */
const DEFAULT_RETRY_DELAYS_MS = [300, 800];

/**
 * 云端认证链路错误。
 * - status = 云端 HTTP 状态码（4xx 透传给路由）
 * - status = 0：daemon 自造（断网 cloud_unreachable / 无本地会话 no_session）
 * - status = 503：auth URL 未配置（auth_not_configured）
 */
export class AuthCloudError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    /** 云端响应体其余字段（如 rate_limited 的 resendAfterSec） */
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(`auth: ${code} (${status})`);
    this.name = 'AuthCloudError';
  }
}

export interface AuthClientOptions {
  /** 云端 base URL；缺省时每次调用懒读 env（测试可中途切换）。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 可注入时钟（测试用）。 */
  now?: () => number;
  /** 网络错误退避覆盖；传 [] 关闭等待（测试用）。 */
  retryDelaysMs?: number[];
  entitlementCache?: EntitlementCache;
  deviceHint?: string;
}

/** 云端可达性状态：unknown=本进程还没成功也没失败过（刚启动/恢复未完成）。 */
export type CloudState = 'unknown' | 'ok' | 'unreachable';

function defaultDeviceHint(): string {
  const shell = process.env['ELECTRON_RUN_AS_NODE'] ? 'desktop' : 'daemon';
  return `Molio ${shell} ${process.platform}/${process.arch}`;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * daemon 侧唯一的云端通信方（设计 §五：Web UI 永不直连云端）。
 *
 * 职责：
 * - 登录流程转发（sendCode / verify / logout）
 * - token 生命周期：single-flight 刷新（并发共享一个 Promise，防 D1 轮换竞争）、
 *   401→刷新→重试一次、access <2min 主动刷新、refresh 被拒不盲试（清本地+标记过期）
 * - 启动恢复（restoreSession，由 index.ts 在 listen 之后异步触发）
 * - 权益快照随 /auth/me 成功刷新到 EntitlementCache
 */
export class AuthClient {
  private tokens: AuthTokens | null | undefined = undefined;
  private refreshInFlight: Promise<AuthTokens> | null = null;
  private loginExpired = false;
  private cloudState: CloudState = 'unknown';
  private readonly opts: AuthClientOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly retryDelaysMs: number[];
  private readonly deviceHint: string;
  readonly entitlementCache: EntitlementCache;

  constructor(opts: AuthClientOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.now = opts.now ?? Date.now;
    this.retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.deviceHint = opts.deviceHint ?? defaultDeviceHint();
    this.entitlementCache = opts.entitlementCache ?? new EntitlementCache();
  }

  /** 云端 base URL（构造参数优先，否则懒读 env）。 */
  getBaseUrl(): string | null {
    return this.opts.baseUrl ?? process.env[AUTH_URL_ENV] ?? null;
  }

  isConfigured(): boolean {
    return this.getBaseUrl() !== null;
  }

  getCloudState(): CloudState {
    return this.cloudState;
  }

  /** refresh 曾被云端拒绝（登录态失效，需重新登录）。 */
  isLoginExpired(): boolean {
    return this.loginExpired;
  }

  /** 本地登录态快照（不发网络请求；/api/auth/status 用）。 */
  getStatus(): AuthStatus {
    const cur = this.currentTokens();
    if (!cur) {
      return this.loginExpired
        ? { loggedIn: false, loginExpired: true }
        : { loggedIn: false };
    }
    const snap = this.entitlementCache.read();
    const cloudOk = this.cloudState === 'ok';
    // 宽限期外且云端不可达 → 权益不再透出（付费功能降级提示，本地功能不受影响）
    const entitlementUsable =
      snap !== null && (cloudOk || this.entitlementCache.isWithinGrace(snap, this.now()));
    return {
      loggedIn: true,
      user: cur.user,
      entitlement: entitlementUsable && snap ? snap.entitlement : undefined,
      stale: !cloudOk,
    };
  }

  // ── 登录流程（routes/auth.ts 调用） ──────────────────────────────

  /** 转发云端 send-code；响应原样返回（含 daily/local 的 devCode，prod 云端本就不返回）。 */
  async sendCode(email: string): Promise<SendCodeResponse> {
    const resp = await this.fetchFromCloud('/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!resp.ok) await this.throwCloudError(resp);
    return (await this.parseBody(resp)) as unknown as SendCodeResponse;
  }

  /** 验证码登录（注册=登录）；成功后 token 落盘，并尽力拉一次权益快照。 */
  async verify(email: string, code: string): Promise<{ user: User }> {
    const resp = await this.fetchFromCloud('/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ email, code, deviceHint: this.deviceHint }),
    });
    if (!resp.ok) await this.throwCloudError(resp);
    const body = (await this.parseBody(resp)) as unknown as VerifyResponse;
    this.adoptTokens(body.accessToken, body.refreshToken, body.user);
    this.loginExpired = false;
    // 快照拉取失败不影响登录成功本身（只影响 stale 展示）
    try {
      await this.me();
    } catch {
      // ignore
    }
    return { user: body.user };
  }

  /**
   * 登出：尽力云端吊销（DELETE /auth/session），无论成败都清本地。
   * 云端不可达时本地登出必须成功（local-first 红线）。
   */
  async logout(): Promise<void> {
    const cur = this.currentTokens();
    if (cur && this.isConfigured()) {
      try {
        const accessToken = await this.getAccessToken();
        await this.fetchFromCloud('/auth/session', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ refreshToken: cur.refreshToken }),
        });
      } catch {
        // 云端不可达 / token 已失效 → 仍本地登出
      }
    }
    this.clearSession({ expired: false });
  }

  /**
   * 启动恢复（设计 §7.3）：读本地 token → 云端 refresh 验证 → 拉权益快照。
   * 必须异步执行、不阻塞 listen（启动超时教训）。
   * - refresh 被拒（401）→ doRefresh 内已清 token 并标记 loginExpired
   * - 云端不可达 → 保留 token 静默降级（本地功能零影响）
   */
  async restoreSession(): Promise<void> {
    const cur = this.currentTokens();
    if (!cur) return; // 从未登录：存量用户零感知
    if (!this.isConfigured()) return; // 云端未配置：保持本地 token，不做网络尝试
    try {
      await this.refresh();
    } catch {
      return; // 401 或断网：doRefresh 已分别处理
    }
    try {
      await this.me();
    } catch {
      // 快照失败不影响登录态恢复
    }
  }

  // ── token 生命周期 ────────────────────────────────────────────────

  /**
   * 取可用 access token：剩余寿命 ≥2min 直接返回；否则先刷新。
   * exp 无法解码时按原样返回，由调用处的 401→刷新→重试兜底。
   * 无本地会话抛 AuthCloudError(0, 'no_session')。
   */
  async getAccessToken(): Promise<string> {
    const cur = this.currentTokens();
    if (!cur) throw new AuthCloudError(0, 'no_session');
    if (
      cur.accessExpiresAt !== undefined &&
      this.now() < cur.accessExpiresAt - PROACTIVE_REFRESH_MS
    ) {
      return cur.accessToken;
    }
    const fresh = await this.refresh();
    return fresh.accessToken;
  }

  /**
   * single-flight 刷新：并发调用共享同一个 Promise。
   * 防 D1（轮换重放误伤）：并发 401 只产生一次 refresh 请求，避免轮换竞争。
   */
  refresh(): Promise<AuthTokens> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  /** GET /auth/me（带 401→刷新→重试一次）；成功后刷新权益快照。 */
  async me(): Promise<MeResponse> {
    let accessToken = await this.getAccessToken();
    let resp = await this.fetchFromCloud('/auth/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (resp.status === 401) {
      const fresh = await this.refresh();
      accessToken = fresh.accessToken;
      resp = await this.fetchFromCloud('/auth/me', {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
      });
    }
    if (!resp.ok) await this.throwCloudError(resp);
    const body = (await this.parseBody(resp)) as unknown as MeResponse;
    this.entitlementCache.write({
      user: body.user,
      entitlement: body.entitlement ?? {},
      updatedAt: this.now(),
    });
    return body;
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async doRefresh(): Promise<AuthTokens> {
    const cur = this.currentTokens();
    if (!cur) throw new AuthCloudError(0, 'no_session');
    const resp = await this.fetchFromCloud('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: cur.refreshToken }),
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        // 云端判定 refresh 失效（过期/吊销/泄漏重放）→ 不盲试，清本地并标记过期（§7.2）
        const body = await this.parseBody(resp);
        this.clearSession({ expired: true });
        throw new AuthCloudError(
          401,
          typeof body.error === 'string' ? body.error : 'invalid_token',
        );
      }
      await this.throwCloudError(resp);
    }
    const body = (await this.parseBody(resp)) as unknown as RefreshResponse;
    this.adoptTokens(body.accessToken, body.refreshToken, cur.user);
    return this.tokens as AuthTokens;
  }

  /** 收新 token 对：先写盘再更新内存（写失败抛出，避免内存领先磁盘；同 FeishuTokenStore 约定）。 */
  private adoptTokens(accessToken: string, refreshToken: string, user: User): void {
    const tokens: AuthTokens = {
      accessToken,
      refreshToken,
      user,
      savedAt: this.now(),
    };
    const exp = decodeAccessExp(accessToken);
    if (exp !== null) tokens.accessExpiresAt = exp;
    writeAuthTokens(tokens);
    this.tokens = tokens;
  }

  private clearSession(opts: { expired: boolean }): void {
    this.tokens = null;
    this.loginExpired = opts.expired;
    clearAuthTokens();
    this.entitlementCache.clear();
  }

  private currentTokens(): AuthTokens | null {
    if (this.tokens === undefined) {
      this.tokens = readAuthTokens();
    }
    return this.tokens;
  }

  /**
   * 云端 HTTP 请求 + 退避重试。
   * - fetch 抛错（断网/DNS/拒连）或 5xx → 按 retryDelaysMs 退避重试
   * - 4xx 不重试（业务拒绝，重试无意义且可能撞限频）
   * - 任何 HTTP 响应都算"云端可达"；只有网络层失败才标 unreachable
   */
  private async fetchFromCloud(path: string, init: RequestInit): Promise<Response> {
    const base = this.getBaseUrl();
    if (!base) throw new AuthCloudError(503, 'auth_not_configured');
    const url = `${base.replace(/\/+$/, '')}${path}`;
    let attempt = 0;
    for (;;) {
      try {
        const resp = await this.fetchImpl(url, {
          ...init,
          headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
        });
        if (resp.status >= 500 && attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        this.cloudState = 'ok';
        return resp;
      } catch {
        if (attempt < this.retryDelaysMs.length) {
          await sleep(this.retryDelaysMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        this.cloudState = 'unreachable';
        throw new AuthCloudError(0, 'cloud_unreachable');
      }
    }
  }

  private async parseBody(resp: Response): Promise<Record<string, unknown>> {
    try {
      const body = (await resp.json()) as Record<string, unknown>;
      return body && typeof body === 'object' ? body : {};
    } catch {
      return {};
    }
  }

  private async throwCloudError(resp: Response): Promise<never> {
    const body = await this.parseBody(resp);
    const code = typeof body.error === 'string' ? body.error : 'unknown';
    const { error: _dropped, ...extra } = body;
    throw new AuthCloudError(resp.status, code, extra);
  }
}
