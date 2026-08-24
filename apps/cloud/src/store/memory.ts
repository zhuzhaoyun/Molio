import type { AuthCodeRecord, AuthStore, RefreshTokenRecord, UserRecord } from './types.js';
import { UniqueViolationError } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** 机会清理窗口：只保留最近 2 天数据（限频查询窗口 = 1 天，富余一倍足够） */
const SWEEP_HORIZON_MS = 2 * DAY_MS;

/** node:test 与本地开发用（无 DATABASE_URL 时自动启用，§十七 L7） */
export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, UserRecord>();
  private codes = new Map<string, AuthCodeRecord>();
  private tokens = new Map<string, RefreshTokenRecord>();

  async createActiveUser(input: {
    id: string;
    email: string;
    nickname: string | null;
    now: number;
  }): Promise<UserRecord> {
    // 与 PG 一致：id 主键冲突与活跃邮箱唯一约束冲突都抛 UniqueViolationError
    if (this.users.has(input.id)) {
      throw new UniqueViolationError(`duplicate user id: ${input.id}`);
    }
    for (const u of this.users.values()) {
      if (u.email === input.email && u.deletedAt === null && u.status === 'active') {
        throw new UniqueViolationError(`active user exists for email: ${input.email}`);
      }
    }
    const rec: UserRecord = {
      id: input.id,
      email: input.email,
      nickname: input.nickname,
      emailVerifiedAt: input.now,
      status: 'active',
      entitlement: {},
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    };
    this.users.set(input.id, rec);
    return { ...rec };
  }

  // find* 一律返回浅拷贝：调用方改返回值不能污染 store 内部状态
  // （如 service 拿到 user 后任何字段修改都不应影响后续查询结果）

  async findActiveUserByEmail(email: string): Promise<UserRecord | null> {
    for (const u of this.users.values()) {
      if (u.email === email && u.deletedAt === null && u.status === 'active') return { ...u };
    }
    return null;
  }

  async findActiveUserById(id: string): Promise<UserRecord | null> {
    const u = this.users.get(id);
    return u && u.deletedAt === null && u.status === 'active' ? { ...u } : null;
  }

  async updateUserNickname(id: string, nickname: string, now: number): Promise<UserRecord | null> {
    // 与 PG 的条件 UPDATE 同语义：仅活跃且未注销的账号可改
    const u = this.users.get(id);
    if (!u || u.deletedAt !== null || u.status !== 'active') return null;
    u.nickname = nickname;
    u.updatedAt = now;
    return { ...u };
  }

  async softDeleteUser(id: string, now: number): Promise<void> {
    const u = this.users.get(id);
    if (!u) return;
    u.deletedAt = now;
    u.updatedAt = now;
  }

  async insertCode(code: AuthCodeRecord): Promise<void> {
    this.sweepCodes(code.createdAt);
    this.codes.set(code.id, { ...code });
  }

  async latestCodeForEmail(email: string): Promise<AuthCodeRecord | null> {
    let latest: AuthCodeRecord | null = null;
    for (const c of this.codes.values()) {
      if (c.email !== email) continue;
      // 同毫秒插入按 ULID id 决胜（id 时间有序），与 PG 的 ORDER BY created_at DESC, id DESC 一致
      if (!latest || c.createdAt > latest.createdAt || (c.createdAt === latest.createdAt && c.id > latest.id)) {
        latest = c;
      }
    }
    return latest ? { ...latest } : null;
  }

  async countCodesForEmailSince(email: string, since: number): Promise<number> {
    return this.countCodesSince((c) => c.email === email, since);
  }

  async oldestCodeForEmailSince(email: string, since: number): Promise<number | null> {
    return this.oldestCodeSince((c) => c.email === email, since);
  }

  async countCodesForIpSince(ip: string, since: number): Promise<number> {
    return this.countCodesSince((c) => c.ip === ip, since);
  }

  async oldestCodeForIpSince(ip: string, since: number): Promise<number | null> {
    return this.oldestCodeSince((c) => c.ip === ip, since);
  }

  private countCodesSince(match: (c: AuthCodeRecord) => boolean, since: number): number {
    let n = 0;
    for (const c of this.codes.values()) {
      if (match(c) && c.createdAt >= since) n++;
    }
    return n;
  }

  private oldestCodeSince(match: (c: AuthCodeRecord) => boolean, since: number): number | null {
    let oldest: number | null = null;
    for (const c of this.codes.values()) {
      if (!match(c) || c.createdAt < since) continue;
      if (oldest === null || c.createdAt < oldest) oldest = c.createdAt;
    }
    return oldest;
  }

  async consumeCode(codeId: string, now: number): Promise<boolean> {
    const c = this.codes.get(codeId);
    if (!c || c.consumedAt !== null) return false;
    c.consumedAt = now;
    return true;
  }

  async incrementCodeAttempts(codeId: string): Promise<number> {
    const c = this.codes.get(codeId);
    if (!c) return 0;
    c.attempts += 1;
    return c.attempts;
  }

  async insertRefreshToken(token: RefreshTokenRecord): Promise<void> {
    this.sweepTokens(token.createdAt);
    this.tokens.set(token.id, { ...token });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const t of this.tokens.values()) {
      if (t.tokenHash === tokenHash) return { ...t };
    }
    return null;
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRecord | null> {
    const t = this.tokens.get(id);
    return t ? { ...t } : null;
  }

  async revokeRefreshToken(id: string, now: number, replacedBy: string | null): Promise<boolean> {
    // 与 PG 的条件 UPDATE 同语义：仅未吊销行生效，竞态下后到一方返回 false
    const t = this.tokens.get(id);
    if (!t || t.revokedAt !== null) return false;
    t.revokedAt = now;
    t.replacedBy = replacedBy;
    return true;
  }

  async revokeAllUserTokens(userId: string, now: number): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.userId === userId && t.revokedAt === null) t.revokedAt = now;
    }
  }

  // ── 机会清理：本地内存模式长跑（pnpm dev:cloud 不重启）防 Map 无限增长 ──
  // PG 由保留期清理任务负责（schema.sql 注释 SQL），此处仅对齐其效果。
  // 清理阈值富余一倍：限频查询窗口 = 1 天，绝不清掉仍可能被查询计入的记录。

  private sweepCodes(now: number): void {
    const horizon = now - SWEEP_HORIZON_MS;
    for (const [id, c] of this.codes) {
      if (c.createdAt < horizon) this.codes.delete(id);
    }
  }

  private sweepTokens(now: number): void {
    const horizon = now - SWEEP_HORIZON_MS;
    for (const [id, t] of this.tokens) {
      // 按 expiresAt 清：过期 token 不可能再通过任何校验路径，删除无损
      if (t.expiresAt < horizon) this.tokens.delete(id);
    }
  }
}
