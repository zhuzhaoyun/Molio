import type {
  AccountDeleteResponse,
  Entitlement,
  MeResponse,
  RefreshResponse,
  SendCodeResponse,
  SessionDeleteResponse,
  User,
  VerifyResponse,
} from '@molio/contracts';
import type { CloudConfig } from './config.js';
import { generateAuthCode, generateNickname, generateRefreshToken, hashCode, hashRefreshToken, ulid } from './crypto.js';
import { signAccessToken } from './jwt.js';
import type { AuthCodeRecord, AuthStore, RefreshTokenRecord, UserRecord } from './store/types.js';
import { UniqueViolationError } from './store/types.js';

export type ServiceErrorCode =
  | 'invalid_email'
  | 'rate_limited'
  | 'invalid_code'
  | 'locked'
  | 'invalid_token'
  | 'invalid_nickname'
  | 'mail_failed';

/** 第一期用到的全部服务错误状态码；类型收窄保证 handleError 不做无声转换 */
export type ServiceErrorStatus = 400 | 401 | 422 | 429;

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    public readonly status: ServiceErrorStatus,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ServiceError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** 宽限窗重放沿替换链追溯的最大深度（防脏数据成环导致死循环） */
const REPLACEMENT_CHAIN_MAX = 10;
// 宽松邮箱格式校验（不做存在性检查）：非空、单个 @、有域名点
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 日志脱敏：邮箱是个人信息（个保法），集中日志（ARMS）长期留存，只留首两位 + 域名 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}

export interface ServiceDeps {
  store: AuthStore;
  config: CloudConfig;
  sendMail: (to: string, code: string) => Promise<void>;
  /** 可注入时钟，测试用 */
  now: () => number;
}

export class AuthService {
  constructor(private deps: ServiceDeps) {}

  /** 邮箱归一化：入口强制小写 + trim（§五设计要点），否则限频与 hash 比对可被大小写绕过 */
  normalizeEmail(raw: string): string {
    return raw.trim().toLowerCase();
  }

  private toApiUser(u: UserRecord): User {
    const user: User = { id: u.id, email: u.email, createdAt: new Date(u.createdAt).toISOString() };
    // null（存量旧行）不透出：undefined 让 JSON 省略该 key，旧客户端不受影响
    if (u.nickname !== null) user.nickname = u.nickname;
    return user;
  }

  // ─── POST /auth/send-code ───

  async sendCode(rawEmail: string, ip: string | null): Promise<SendCodeResponse> {
    const { store, config } = this.deps;
    const now = this.deps.now();
    const email = this.normalizeEmail(rawEmail);
    if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
      throw new ServiceError('invalid_email', 400);
    }

    // 限频全部走 DB 查询（FC 多实例，无内存限流，§五）
    const resendMs = config.rate.emailResendSec * 1000;
    const latest = await store.latestCodeForEmail(email);
    if (latest && now - latest.createdAt < resendMs) {
      throw new ServiceError('rate_limited', 429, {
        resendAfterSec: Math.ceil((resendMs - (now - latest.createdAt)) / 1000),
      });
    }

    await this.checkDailyLimit('email', email, config.rate.emailDailyMax, now);
    if (ip) {
      await this.checkDailyLimit('ip', ip, config.rate.ipDailyMax, now);
    }

    const code = generateAuthCode();
    const rec: AuthCodeRecord = {
      id: ulid(now),
      email,
      codeHash: hashCode(code, config.codePepper),
      expiresAt: now + config.codeTtlSec * 1000,
      attempts: 0,
      consumedAt: null,
      ip,
      createdAt: now,
    };
    await store.insertCode(rec);
    try {
      await this.deps.sendMail(email, code);
    } catch (e) {
      // 发信通道失败（DirectMail 拒绝/超时等）。回 422 而非 5xx：
      // daemon auth-client 对 5xx 会退避重试，重试撞 60s 重发限频变成误导性的
      // rate_limited；4xx 原样透传不重试。验证码记录保留（限频完整性优先，
      // 用户按 resendAfterSec 重试即可）。
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[cloud] send-code mail failed: to=${maskEmail(email)} ${detail}`);
      throw new ServiceError('mail_failed', 422);
    }

    // 防枚举（§十七 L2）：已注册/未注册邮箱一律 202。
    // devCode 仅非 prod 返回（D2：E2E 取码；prod 严格不返回）。
    return {
      ok: true,
      resendAfterSec: config.rate.emailResendSec,
      devCode: config.env === 'prod' ? undefined : code,
    };
  }

  /** 每邮箱/每 IP 每日上限：超限抛 rate_limited，附带解锁倒计时 */
  private async checkDailyLimit(kind: 'email' | 'ip', key: string, max: number, now: number): Promise<void> {
    const { store, config } = this.deps;
    const since = now - DAY_MS;
    const count =
      kind === 'email' ? await store.countCodesForEmailSince(key, since) : await store.countCodesForIpSince(key, since);
    if (count < max) return;
    const oldest =
      kind === 'email' ? await store.oldestCodeForEmailSince(key, since) : await store.oldestCodeForIpSince(key, since);
    throw new ServiceError('rate_limited', 429, {
      resendAfterSec: oldest === null ? config.rate.emailResendSec : Math.ceil((oldest + DAY_MS - now) / 1000),
    });
  }

  // ─── POST /auth/verify（注册 = 登录） ───

  async verify(rawEmail: string, rawCode: string, deviceHint?: string): Promise<VerifyResponse> {
    const { store, config } = this.deps;
    const now = this.deps.now();
    const email = this.normalizeEmail(rawEmail);

    const latest = await store.latestCodeForEmail(email);
    // 统一回 invalid_code，不泄露"码不存在/已过期/已用"的差异（防枚举同思路）
    if (!latest || latest.consumedAt !== null || latest.expiresAt <= now) {
      throw new ServiceError('invalid_code', 401);
    }
    if (latest.attempts >= config.codeMaxAttempts) {
      throw new ServiceError('locked', 401);
    }
    if (hashCode(String(rawCode).trim(), config.codePepper) !== latest.codeHash) {
      await store.incrementCodeAttempts(latest.id);
      throw new ServiceError('invalid_code', 401);
    }

    // 一次性：原子消费，竞态下只有一方成功（并发注册兜底第一道）
    const consumed = await store.consumeCode(latest.id, now);
    if (!consumed) throw new ServiceError('invalid_code', 401);

    // 隐式注册：邮箱不存在（或对应账号已注销）则建新号；
    // unique_violation 兜底并发注册，回退复用刚建账号（§五设计要点）
    let user = await store.findActiveUserByEmail(email);
    if (!user) {
      try {
        user = await store.createActiveUser({ id: ulid(now), email, nickname: generateNickname(), now });
      } catch (e) {
        if (e instanceof UniqueViolationError) {
          user = await store.findActiveUserByEmail(email);
        } else {
          throw e;
        }
      }
    }
    // 窗口极窄（冲突后重查仍查不到）；结构化错误保证客户端拿到可映射的 code 而非裸 500
    if (!user) throw new ServiceError('invalid_code', 401);

    const pair = await this.mintTokenPair(user, now, deviceHint ?? null);
    return { accessToken: pair.accessToken, refreshToken: pair.refreshToken, user: this.toApiUser(user) };
  }

  /** 生成一对新 token：ULID id + 随机 refresh + 签名 access（issue/rotate 共用，防两处漂移） */
  private async mintTokenPair(user: UserRecord, now: number, deviceHint: string | null) {
    const { config, store } = this.deps;
    const tokenId = ulid(now);
    const refreshToken = generateRefreshToken();
    await store.insertRefreshToken({
      id: tokenId,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      deviceHint,
      createdAt: now,
      expiresAt: now + config.refreshTtlSec * 1000,
      revokedAt: null,
      replacedBy: null,
    });
    return { tokenId, refreshToken, accessToken: this.signAccess(user, tokenId, now) };
  }

  private signAccess(user: UserRecord, tokenId: string, now: number): string {
    const { config } = this.deps;
    const nowSec = Math.floor(now / 1000);
    return signAccessToken(
      { sub: user.id, email: user.email, jti: tokenId, iat: nowSec, exp: nowSec + config.accessTtlSec },
      config.jwtSecret,
      config.jwtKid,
    );
  }

  // ─── POST /auth/refresh（轮换 + 重放检测） ───

  async refresh(rawToken: string): Promise<RefreshResponse> {
    const { store } = this.deps;
    const now = this.deps.now();

    const rec = await store.findRefreshTokenByHash(hashRefreshToken(rawToken));
    if (!rec) throw new ServiceError('invalid_token', 401);

    if (rec.revokedAt === null) {
      if (rec.expiresAt <= now) throw new ServiceError('invalid_token', 401);
      const rotated = await this.rotate(rec, now);
      if (rotated) return rotated;
      // 原子吊销竞态失败：同一 token 被并发请求先行轮换 → 读最新状态按重放路径处理
      const fresh = await store.findRefreshTokenById(rec.id);
      if (!fresh || fresh.revokedAt === null) throw new ServiceError('invalid_token', 401);
      return this.handleRevokedReplay(fresh, now);
    }
    return this.handleRevokedReplay(rec, now);
  }

  /**
   * 已吊销 token 再现的判定：
   * - 宽限窗内且有替换链 → 视为"响应丢失的客户端重试"，沿链追到 head 再轮换（不触发全吊销）
   * - 超窗 / 无替换链（人工登出、admin 吊销）/ 链头也失效 → 判定泄漏，吊销该用户全部 session
   */
  private async handleRevokedReplay(rec: RefreshTokenRecord, now: number) {
    const { store, config } = this.deps;
    const withinGrace = rec.replacedBy !== null && now - (rec.revokedAt ?? now) < config.rotationGraceSec * 1000;
    if (withinGrace) {
      let head: RefreshTokenRecord = rec;
      for (let i = 0; i < REPLACEMENT_CHAIN_MAX && head.replacedBy; i++) {
        const next = await store.findRefreshTokenById(head.replacedBy);
        if (!next) break;
        head = next;
      }
      if (head.revokedAt === null && head.expiresAt > now) {
        const rotated = await this.rotate(head, now);
        if (rotated) return rotated;
      }
      // 链头也已失效（或再次竞态失败）→ 按攻击处理
    }
    await store.revokeAllUserTokens(rec.userId, now);
    throw new ServiceError('invalid_token', 401);
  }

  /** 轮换：原子吊销旧 token（仅未吊销行生效）+ 发新对。竞态失败返回 null，调用方走重放路径 */
  private async rotate(rec: RefreshTokenRecord, now: number) {
    const { store, config } = this.deps;
    const user = await store.findActiveUserById(rec.userId);
    if (!user) throw new ServiceError('invalid_token', 401);

    const tokenId = ulid(now);
    const revoked = await store.revokeRefreshToken(rec.id, now, tokenId);
    if (!revoked) return null;

    const refreshToken = generateRefreshToken();
    await store.insertRefreshToken({
      id: tokenId,
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      deviceHint: rec.deviceHint,
      createdAt: now,
      expiresAt: now + config.refreshTtlSec * 1000,
      revokedAt: null,
      replacedBy: null,
    });
    return { accessToken: this.signAccess(user, tokenId, now), refreshToken };
  }

  // ─── GET /auth/me ───

  async me(userId: string): Promise<MeResponse> {
    const user = await this.deps.store.findActiveUserById(userId);
    if (!user) throw new ServiceError('invalid_token', 401);
    return { user: this.toApiUser(user), entitlement: user.entitlement as Entitlement };
  }

  // ─── PATCH /auth/me（修改当前用户资料，第一期仅 nickname） ───

  /**
   * 昵称校验：trim 后按 **Unicode code point** 计数 1-20。
   * 用 Array.from 而非 string.length——后者按 UTF-16 单元计数，
   * emoji（如 '😀'.length === 2）会被错误折半。
   * 不支持清空昵称：空串/纯空白一律 400（第一期用户恒有昵称）。
   */
  async updateMe(userId: string, nickname: string): Promise<MeResponse> {
    const now = this.deps.now();
    const trimmed = nickname.trim();
    if (trimmed.length === 0 || Array.from(trimmed).length > 20) {
      throw new ServiceError('invalid_nickname', 400);
    }
    const updated = await this.deps.store.updateUserNickname(userId, trimmed, now);
    // 账号不存在/已注销：与 me() 一致按 401 处理
    if (!updated) throw new ServiceError('invalid_token', 401);
    return { user: this.toApiUser(updated), entitlement: updated.entitlement as Entitlement };
  }

  // ─── DELETE /auth/session（本机登出：只吊销当前设备） ───

  async logout(userId: string, rawRefreshToken: string): Promise<SessionDeleteResponse> {
    const { store } = this.deps;
    const now = this.deps.now();
    const rec = await store.findRefreshTokenByHash(hashRefreshToken(rawRefreshToken));
    // 归属校验：只吊销调用者自己的 session；他人 token 静默忽略
    // （不泄露存在性，登出对调用方语义不变；防止越权吊销他人会话）
    if (rec && rec.userId === userId && rec.revokedAt === null) {
      await store.revokeRefreshToken(rec.id, now, null);
    }
    return { ok: true };
  }

  // ─── DELETE /auth/account（注销：软删除 + 吊销全部 session，个保法） ───
  // 注销后同邮箱再注册 = 新账号（§二拍板，§十七 L8）

  async deleteAccount(userId: string): Promise<AccountDeleteResponse> {
    const { store } = this.deps;
    const now = this.deps.now();
    await store.softDeleteUser(userId, now);
    await store.revokeAllUserTokens(userId, now);
    return { ok: true };
  }
}
