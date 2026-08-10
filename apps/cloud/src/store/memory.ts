import type { AuthCodeRecord, AuthStore, RefreshTokenRecord, UserRecord } from './types.js';
import { UniqueViolationError } from './types.js';

/** node:test 与本地开发用（无 DATABASE_URL 时自动启用，§十七 L7） */
export class MemoryAuthStore implements AuthStore {
  private users = new Map<string, UserRecord>();
  private codes = new Map<string, AuthCodeRecord>();
  private tokens = new Map<string, RefreshTokenRecord>();

  async createActiveUser(input: { id: string; email: string; now: number }): Promise<UserRecord> {
    for (const u of this.users.values()) {
      if (u.email === input.email && u.deletedAt === null) {
        throw new UniqueViolationError(`active user exists for email: ${input.email}`);
      }
    }
    const rec: UserRecord = {
      id: input.id,
      email: input.email,
      emailVerifiedAt: input.now,
      status: 'active',
      entitlement: {},
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    };
    this.users.set(input.id, rec);
    return rec;
  }

  async findActiveUserByEmail(email: string): Promise<UserRecord | null> {
    for (const u of this.users.values()) {
      if (u.email === email && u.deletedAt === null && u.status === 'active') return u;
    }
    return null;
  }

  async findActiveUserById(id: string): Promise<UserRecord | null> {
    const u = this.users.get(id);
    return u && u.deletedAt === null && u.status === 'active' ? u : null;
  }

  async softDeleteUser(id: string, now: number): Promise<void> {
    const u = this.users.get(id);
    if (!u) return;
    u.deletedAt = now;
    u.updatedAt = now;
  }

  async insertCode(code: AuthCodeRecord): Promise<void> {
    this.codes.set(code.id, { ...code });
  }

  async latestCodeForEmail(email: string): Promise<AuthCodeRecord | null> {
    let latest: AuthCodeRecord | null = null;
    for (const c of this.codes.values()) {
      if (c.email !== email) continue;
      if (!latest || c.createdAt > latest.createdAt) latest = c;
    }
    return latest;
  }

  async countCodesForEmailSince(email: string, since: number): Promise<number> {
    let n = 0;
    for (const c of this.codes.values()) {
      if (c.email === email && c.createdAt >= since) n++;
    }
    return n;
  }

  async oldestCodeForEmailSince(email: string, since: number): Promise<number | null> {
    let oldest: number | null = null;
    for (const c of this.codes.values()) {
      if (c.email !== email || c.createdAt < since) continue;
      if (oldest === null || c.createdAt < oldest) oldest = c.createdAt;
    }
    return oldest;
  }

  async countCodesForIpSince(ip: string, since: number): Promise<number> {
    let n = 0;
    for (const c of this.codes.values()) {
      if (c.ip === ip && c.createdAt >= since) n++;
    }
    return n;
  }

  async oldestCodeForIpSince(ip: string, since: number): Promise<number | null> {
    let oldest: number | null = null;
    for (const c of this.codes.values()) {
      if (c.ip !== ip || c.createdAt < since) continue;
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
    this.tokens.set(token.id, { ...token });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const t of this.tokens.values()) {
      if (t.tokenHash === tokenHash) return t;
    }
    return null;
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRecord | null> {
    return this.tokens.get(id) ?? null;
  }

  async revokeRefreshToken(id: string, now: number, replacedBy: string | null): Promise<void> {
    const t = this.tokens.get(id);
    if (!t) return;
    t.revokedAt = now;
    t.replacedBy = replacedBy;
  }

  async revokeAllUserTokens(userId: string, now: number): Promise<void> {
    for (const t of this.tokens.values()) {
      if (t.userId === userId && t.revokedAt === null) t.revokedAt = now;
    }
  }
}
