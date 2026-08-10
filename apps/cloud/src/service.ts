import type { Entitlement, User } from '@molio/contracts';
import type { CloudConfig } from './config.js';
import { generateAuthCode, generateRefreshToken, hashCode, hashRefreshToken, ulid } from './crypto.js';
import { signAccessToken } from './jwt.js';
import type { AuthCodeRecord, AuthStore, RefreshTokenRecord, UserRecord } from './store/types.js';
import { UniqueViolationError } from './store/types.js';

export type ServiceErrorCode =
  | 'invalid_email'
  | 'rate_limited'
  | 'invalid_code'
  | 'locked'
  | 'invalid_token';

export class ServiceError extends Error {
  constructor(
    public readonly code: ServiceErrorCode,
    public readonly status: number,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'ServiceError';
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 宽松邮箱格式校验（不做存在性检查）：非空、单个 @、有域名点
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    return { id: u.id, email: u.email, createdAt: new Date(u.createdAt).toISOString() };
  }

  // ─── POST /auth/send-code ───

  async sendCode(rawEmail: string, ip: string | null) {
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

    const emailCount = await store.countCodesForEmailSince(email, now - DAY_MS);
    if (emailCount >= config.rate.emailDailyMax) {
      const oldest = await store.oldestCodeForEmailSince(email, now - DAY_MS);
      throw new ServiceError('rate_limited', 429, {
        resendAfterSec: oldest === null ? config.rate.emailResendSec : Math.ceil((oldest + DAY_MS - now) / 1000),
      });
    }

    if (ip) {
      const ipCount = await store.countCodesForIpSince(ip, now - DAY_MS);
      if (ipCount >= config.rate.ipDailyMax) {
        const oldest = await store.oldestCodeForIpSince(ip, now - DAY_MS);
        throw new ServiceError('rate_limited', 429, {
          resendAfterSec: oldest === null ? config.rate.emailResendSec : Math.ceil((oldest + DAY_MS - now) / 1000),
        });
      }
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
    await this.deps.sendMail(email, code);

    // 防枚举（§十七 L2）：已注册/未注册邮箱一律 202。
    // devCode 仅非 prod 返回（D2：E2E 取码；prod 严格不返回）。
    return {
      ok: true,
      resendAfterSec: config.rate.emailResendSec,
      devCode: config.env === 'prod' ? undefined : code,
    };
  }

  // ─── POST /auth/verify（注册 = 登录） ───

  async verify(rawEmail: string, rawCode: string, deviceHint?: string) {
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
        user = await store.createActiveUser({ id: ulid(now), email, now });
      } catch (e) {
        if (e instanceof UniqueViolationError) {
          user = await store.findActiveUserByEmail(email);
        } else {
          throw e;
        }
      }
    }
    if (!user) throw new Error('verify: register race lost (user vanished)');

    return this.issueTokens(user, now, deviceHint ?? null);
  }

  private async issueTokens(user: UserRecord, now: number, deviceHint: string | null) {
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
    const accessToken = this.signAccess(user, tokenId, now);
    return { accessToken, refreshToken, user: this.toApiUser(user) };
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

  // ─── POST /auth/refresh（轮换 + D1 重放检测） ───

  async refresh(rawToken: string) {
    const { store, config } = this.deps;
    const now = this.deps.now();

    const rec = await store.findRefreshTokenByHash(hashRefreshToken(rawToken));
    if (!rec) throw new ServiceError('invalid_token', 401);

    if (rec.revokedAt !== null) {
      const withinGrace = rec.replacedBy !== null && now - rec.revokedAt < config.rotationGraceSec * 1000;
      if (withinGrace) {
        // D1 重试宽容：被轮换吊销且窗内重放 → 视为"响应丢失的重试"，
        // 沿替换链追到当前 head 并轮换，返回新 token 对（不触发全吊销）
        let head: RefreshTokenRecord = rec;
        for (let i = 0; i < 10 && head.replacedBy; i++) {
          const next = await store.findRefreshTokenById(head.replacedBy);
          if (!next) break;
          head = next;
        }
        if (head.revokedAt === null && head.expiresAt > now) {
          return this.rotate(head, now);
        }
        // 链头也已失效 → 按攻击处理
        await store.revokeAllUserTokens(rec.userId, now);
        throw new ServiceError('invalid_token', 401);
      }
      // 超宽限窗重放，或人工吊销（logout/admin，无 replaced_by）后再现 → 判定泄漏，全吊销
      await store.revokeAllUserTokens(rec.userId, now);
      throw new ServiceError('invalid_token', 401);
    }

    if (rec.expiresAt <= now) throw new ServiceError('invalid_token', 401);
    return this.rotate(rec, now);
  }

  private async rotate(rec: RefreshTokenRecord, now: number) {
    const { store, config } = this.deps;
    const user = await store.findActiveUserById(rec.userId);
    if (!user) throw new ServiceError('invalid_token', 401);

    const tokenId = ulid(now);
    const refreshToken = generateRefreshToken();
    await store.revokeRefreshToken(rec.id, now, tokenId);
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

  async me(userId: string) {
    const user = await this.deps.store.findActiveUserById(userId);
    if (!user) throw new ServiceError('invalid_token', 401);
    return { user: this.toApiUser(user), entitlement: user.entitlement as Entitlement };
  }

  // ─── DELETE /auth/session（本机登出：只吊销当前设备） ───

  async logout(rawRefreshToken: string) {
    const { store } = this.deps;
    const now = this.deps.now();
    const rec = await store.findRefreshTokenByHash(hashRefreshToken(rawRefreshToken));
    if (rec && rec.revokedAt === null) {
      await store.revokeRefreshToken(rec.id, now, null);
    }
    return { ok: true };
  }

  // ─── DELETE /auth/account（注销：软删除 + 吊销全部 session，个保法） ───
  // 注销后同邮箱再注册 = 新账号（§二拍板，§十七 L8）

  async deleteAccount(userId: string) {
    const { store } = this.deps;
    const now = this.deps.now();
    await store.softDeleteUser(userId, now);
    await store.revokeAllUserTokens(userId, now);
    return { ok: true };
  }
}
