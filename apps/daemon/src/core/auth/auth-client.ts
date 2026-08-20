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

/** 云端地址 env：显式设置（含纯空白）时覆盖内置默认；纯空白按未配置。 */
export const AUTH_URL_ENV = 'MOLIO_AUTH_URL';

/**
 * 官方云端认证地址（auth.molio.cn 已上线）。daemon 内置默认值，让
 * pnpm dev / Docker / 独立 daemon 全部开箱即用登录，无需任何配置。
 * 优先级：AuthClientOptions.baseUrl > env MOLIO_AUTH_URL > 本默认值；
 * env 显式设为空白 = 关闭登录（登录端点回 503 auth_not_configured）。
 * ⚠️ 与 apps/desktop/src/main.js 的 DEFAULT_AUTH_URL 保持一致
 * （桌面壳另有一份注入，见该文件；两处值变更须同步）。
 */
export const DEFAULT_AUTH_URL = 'https://auth.molio.cn';

/** access 剩余寿命 <2min 主动刷新（设计 §7.2），避免请求中途失败。 */
export const PROACTIVE_REFRESH_MS = 2 * 60 * 1000;

/** 网络错误退避延迟（ms）。4xx 不重试；5xx/断网重试。 */
const DEFAULT_RETRY_DELAYS_MS = [300, 800];

/**
 * 云端请求整体超时。undici 默认只有 socket 级超时——云端 hang 住（半开连接、
 * LB 黑洞）时登录/刷新链路会无限阻塞；10s 整体兜底，超时按网络失败走重试/降级。
 */
const CLOUD_FETCH_TIMEOUT_MS = 10_000;

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
 * 合并请求头：content-type 兜底 + 调用方头统一小写化。
 * 不做小写化时，调用方传 `Authorization`/`Content-Type`（大写驼峰）会与兜底键
 * 并存，undici 可能发出重复头，行为不可预期。
 */
function mergeJsonHeaders(extra: NonNullable<RequestInit['headers']> | undefined): Record<string, string> {
  const merged: Record<string, string> = { 'content-type': 'application/json' };
  if (extra) {
    new Headers(extra).forEach((value, key) => {
      merged[key.toLowerCase()] = value;
    });
  }
  return merged;
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

  /**
   * 云端 base URL：构造参数 > env MOLIO_AUTH_URL > 内置官方默认（DEFAULT_AUTH_URL）。
   * 每次调用懒读（测试可中途切换 env）。两端空白 trim 掉；
   * env 显式纯空白按未配置（私有化关闭登录的口子），env 未设置回落到官方默认。
   */
  getBaseUrl(): string | null {
    const raw = this.opts.baseUrl ?? process.env[AUTH_URL_ENV] ?? DEFAULT_AUTH_URL;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
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

  /** 本地登录态快照（不发网络请求；/api/auth/status 用）。异步：首读需落盘解码（桌面模式含解密 RPC）。 */
  async getStatus(): Promise<AuthStatus> {
    const configured = this.isConfigured();
    const cur = await this.currentTokens();
    if (!cur) {
      return this.loginExpired
        ? { loggedIn: false, configured, loginExpired: true }
        : { loggedIn: false, configured };
    }
    const snap = this.entitlementCache.read();
    const cloudOk = this.cloudState === 'ok';
    // 宽限期外且云端不可达 → 权益不再透出（付费功能降级提示，本地功能不受影响）
    const entitlementUsable =
      snap !== null && (cloudOk || this.entitlementCache.isWithinGrace(snap, this.now()));
    return {
      loggedIn: true,
      configured,
      user: cur.user,
      entitlement: entitlementUsable && snap ? snap.entitlement : undefined,
      stale: !cloudOk,
    };
  }

  // ── 登录流程（routes/auth.ts 调用） ──────────────────────────────

  /**
   * 转发云端 send-code；响应原样返回（含 daily/local 的 devCode，prod 云端本就不返回）。
   * **不重试**：send-code 非幂等——云端可能已发信才失败，重试会重复发信并撞 60s 重发限频。
   */
  async sendCode(email: string): Promise<SendCodeResponse> {
    const resp = await this.fetchFromCloud(
      '/auth/send-code',
      { method: 'POST', body: JSON.stringify({ email }) },
      { retryable: false },
    );
    if (!resp.ok) await this.throwCloudError(resp);
    return (await this.parseBody(resp)) as unknown as SendCodeResponse;
  }

  /**
   * 验证码登录（注册=登录）；成功后 token 落盘，并尽力拉一次权益快照。
   * **不重试**：verify 消费一次性验证码——云端可能已消费才失败，重试会得到
   * invalid_code，把"其实已成功"的登录误报为失败。
   */
  async verify(email: string, code: string): Promise<{ user: User }> {
    const resp = await this.fetchFromCloud(
      '/auth/verify',
      { method: 'POST', body: JSON.stringify({ email, code, deviceHint: this.deviceHint }) },
      { retryable: false },
    );
    if (!resp.ok) await this.throwCloudError(resp);
    const body = (await this.parseBody(resp)) as unknown as VerifyResponse;
    await this.adoptTokens(body.accessToken, body.refreshToken, body.user);
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
    const cur = await this.currentTokens();
    if (cur && this.isConfigured()) {
      try {
        const accessToken = await this.getAccessToken();
        // getAccessToken 可能触发 refresh（轮换）：必须重读最新 refresh token 去吊销。
        // 若沿用上面预读的 cur.refreshToken，DELETE body 带的就是已被轮换（云端已吊销）
        // 的旧 token，云端找不到可吊销对象，本设备 session 在云端残留。
        const latest = (await this.currentTokens()) ?? cur;
        await this.fetchFromCloud(
          '/auth/session',
          {
            method: 'DELETE',
            headers: { authorization: `Bearer ${accessToken}` },
            body: JSON.stringify({ refreshToken: latest.refreshToken }),
          },
          { retryable: false }, // 吊销幂等但无重试价值；失败走本地必清
        );
      } catch {
        // 云端不可达 / token 已失效 → 仍本地登出
      }
    }
    this.clearSession({ expired: false });
  }

  /**
   * 注销账号（设计 §7.4，个保法硬要求）：云端 DELETE /auth/account 软删除 +
   * 吊销全部 session，成功后清本地 token/权益。
   * 与 logout 的语义差异：注销是云端权威操作——云端不可达时**抛错不清本地**
   * （账号还在，token 保留以便重试）；logout 则本地必清。
   * 无本地会话抛 AuthCloudError(0, 'no_session')。
   */
  async deleteAccount(): Promise<void> {
    const resp = await this.fetchWithBearer('/auth/account', 'DELETE');
    if (!resp.ok) await this.throwCloudError(resp);
    this.clearSession({ expired: false });
  }

  /**
   * 启动恢复（设计 §7.3）：读本地 token → 云端 refresh 验证 → 拉权益快照。
   * 必须异步执行、不阻塞 listen（启动超时教训）。
   * - refresh 被拒（401）→ doRefresh 内已清 token 并标记 loginExpired
   * - 云端不可达 → 保留 token 静默降级（本地功能零影响）
   */
  async restoreSession(): Promise<void> {
    const cur = await this.currentTokens();
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
   * exp 无法解码（accessExpiresAt 缺省）时**按原样返回**——token 可能完全有效
   * （云端换发格式/解码异常），由调用处的 401→刷新→重试兜底；此处抢跑刷新会
   * 在每次调用都白烧一次轮换。
   * 无本地会话抛 AuthCloudError(0, 'no_session')。
   */
  async getAccessToken(): Promise<string> {
    const cur = await this.currentTokens();
    if (!cur) throw new AuthCloudError(0, 'no_session');
    if (
      cur.accessExpiresAt === undefined ||
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
    const resp = await this.fetchWithBearer('/auth/me', 'GET');
    if (!resp.ok) await this.throwCloudError(resp);
    const body = (await this.parseBody(resp)) as unknown as MeResponse;
    this.entitlementCache.write({
      user: body.user,
      entitlement: body.entitlement ?? {},
      updatedAt: this.now(),
    });
    return body;
  }

  /**
   * PATCH /auth/me（修改昵称；带 401→刷新→重试一次）。
   * 成功后同步两处本地快照：
   * - 权益快照（与 me() 一致，响应即最新 user + entitlement）
   * - token 文件里的 user 副本（/api/auth/status 的数据源）——经 adoptTokens
   *   原 token 对 + 新 user 重写，复用其写盘路径与 generation 守卫；
   *   不手改 this.tokens，避免绕过「先写盘后内存」不变量
   */
  async updateMe(nickname: string): Promise<MeResponse> {
    const resp = await this.fetchWithBearer('/auth/me', 'PATCH', JSON.stringify({ nickname }));
    if (!resp.ok) await this.throwCloudError(resp);
    const body = (await this.parseBody(resp)) as unknown as MeResponse;
    this.entitlementCache.write({
      user: body.user,
      entitlement: body.entitlement ?? {},
      updatedAt: this.now(),
    });
    const cur = await this.currentTokens();
    if (cur) {
      await this.adoptTokens(cur.accessToken, cur.refreshToken, body.user);
    }
    return body;
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  /**
   * Bearer 请求 + 401→刷新→重试一次（me / updateMe / deleteAccount 共享）。
   * body 是字符串（非 stream）：401 重试时可原样重发。
   */
  private async fetchWithBearer(
    path: string,
    method: 'GET' | 'DELETE' | 'PATCH',
    body?: string,
  ): Promise<Response> {
    const init = (token: string): RequestInit => ({
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body } : {}),
    });
    let accessToken = await this.getAccessToken();
    let resp = await this.fetchFromCloud(path, init(accessToken));
    if (resp.status === 401) {
      const fresh = await this.refresh();
      resp = await this.fetchFromCloud(path, init(fresh.accessToken));
    }
    return resp;
  }

  private async doRefresh(): Promise<AuthTokens> {
    const cur = await this.currentTokens();
    if (!cur) throw new AuthCloudError(0, 'no_session');
    const resp = await this.fetchFromCloud('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken: cur.refreshToken }),
    });
    // 会话纪元守卫：refresh 在途期间会话被替换（并发新登录 verify / 登出 clearSession）→
    // 丢弃本次刷新结果。既不能用旧 user 覆盖新会话，也不能拿旧 token 的 401 去清新会话。
    // 典型场景：index.ts listen 后异步 restoreSession 与用户立即重新登录的竞态。
    if (this.tokens !== cur) throw new AuthCloudError(409, 'session_replaced');
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
    await this.adoptTokens(body.accessToken, body.refreshToken, cur.user, cur);
    return this.tokens as AuthTokens;
  }

  /**
   * 收新 token 对：先写盘再更新内存（fs 写失败抛出，避免内存领先磁盘；同 FeishuTokenStore 约定）。
   * 例外：桌面模式加密失败（crypto 服务暂挂）→ token-store 返回 written:false，
   * 此时仍更新内存（token 本身有效，只是未落盘；重启才会丢，属可接受降级）。
   *
   * expectCurrent（doRefresh 传入）：写盘是异步的（桌面加密 RPC），期间会话可能被
   * 登出/新登录替换。落盘后复核身份：已替换则放弃收编（不复活旧 token），抛
   * session_replaced。token-store 侧另有 generation 计数防"登出后旧写复活文件"。
   */
  private async adoptTokens(
    accessToken: string,
    refreshToken: string,
    user: User,
    expectCurrent?: AuthTokens,
  ): Promise<void> {
    const tokens: AuthTokens = {
      accessToken,
      refreshToken,
      user,
      savedAt: this.now(),
    };
    const exp = decodeAccessExp(accessToken);
    if (exp !== null) tokens.accessExpiresAt = exp;
    const result = await writeAuthTokens(tokens);
    if (expectCurrent !== undefined && this.tokens !== expectCurrent) {
      throw new AuthCloudError(409, 'session_replaced');
    }
    if (!result.written && result.reason === 'encrypt_failed') {
      console.warn(
        'auth: desktop crypto encrypt failed — tokens kept in memory, disk write skipped',
      );
    }
    this.tokens = tokens;
  }

  private clearSession(opts: { expired: boolean }): void {
    this.tokens = null;
    this.loginExpired = opts.expired;
    clearAuthTokens();
    this.entitlementCache.clear();
  }

  private async currentTokens(): Promise<AuthTokens | null> {
    if (this.tokens === undefined) {
      this.tokens = await readAuthTokens();
    }
    return this.tokens;
  }

  /**
   * 云端 HTTP 请求 + 退避重试。
   * - fetch 抛错（断网/DNS/拒连/超时）或 5xx → 按 retryDelaysMs 退避重试
   * - 4xx 不重试（业务拒绝，重试无意义且可能撞限频）
   * - **非幂等请求（sendCode/verify/吊销）强制不重试**（retryable:false）
   * - 任何 HTTP 响应都算"云端可达"；只有网络层失败才标 unreachable
   * - 每次尝试带 10s 整体超时信号，云端 hang 不住登录链路
   */
  private async fetchFromCloud(
    path: string,
    init: RequestInit,
    opts: { retryable?: boolean } = {},
  ): Promise<Response> {
    const retryable = opts.retryable ?? true;
    const base = this.getBaseUrl();
    if (!base) throw new AuthCloudError(503, 'auth_not_configured');
    const url = `${base.replace(/\/+$/, '')}${path}`;
    let attempt = 0;
    for (;;) {
      try {
        const resp = await this.fetchImpl(url, {
          ...init,
          headers: mergeJsonHeaders(init.headers),
          // 调用方自带 signal 优先；否则每轮尝试新鲜的整体超时
          signal: init.signal ?? AbortSignal.timeout(CLOUD_FETCH_TIMEOUT_MS),
        });
        if (resp.status >= 500 && retryable && attempt < this.retryDelaysMs.length) {
          // 丢弃 5xx 响应体，避免 undici 挂住连接（下一个尝试是新请求）
          resp.body?.cancel().catch(() => {});
          await sleep(this.retryDelaysMs[attempt] ?? 0);
          attempt += 1;
          continue;
        }
        this.cloudState = 'ok';
        return resp;
      } catch {
        if (retryable && attempt < this.retryDelaysMs.length) {
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
