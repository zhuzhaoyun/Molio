import type { Pool } from 'pg';
import type { AuthCodeRecord, AuthStore, RefreshTokenRecord, UserRecord } from './types.js';
import { UniqueViolationError } from './types.js';

// 行类型：node-pg 把 TIMESTAMPTZ 解析为 Date，JSONB 解析为对象
interface UserRow {
  id: string;
  email: string;
  email_verified_at: Date | null;
  status: string;
  entitlement: Record<string, unknown> | string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

interface CodeRow {
  id: string;
  email: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  ip: string | null;
  created_at: Date;
}

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  device_hint: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
}

function ms(d: Date | null): number | null {
  return d === null ? null : d.getTime();
}

/** entitlement 防御解析：坏数据（脏 JSON 字符串）不能把 /auth/me 打成 500 */
function parseEntitlement(raw: Record<string, unknown> | string | null): Record<string, unknown> {
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    emailVerifiedAt: ms(row.email_verified_at),
    // 白名单收窄：未知 status（将来迁移产生的中间态）一律按 deactivated 处理，
    // 绝不向调用方漏出 union 之外的值
    status: row.status === 'active' ? 'active' : 'deactivated',
    entitlement: parseEntitlement(row.entitlement),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    deletedAt: ms(row.deleted_at),
  };
}

function toCode(row: CodeRow): AuthCodeRecord {
  return {
    id: row.id,
    email: row.email,
    codeHash: row.code_hash,
    expiresAt: row.expires_at.getTime(),
    attempts: row.attempts,
    consumedAt: ms(row.consumed_at),
    ip: row.ip,
    createdAt: row.created_at.getTime(),
  };
}

function toToken(row: TokenRow): RefreshTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    deviceHint: row.device_hint,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at.getTime(),
    revokedAt: ms(row.revoked_at),
    replacedBy: row.replaced_by,
  };
}

/** 生产持久层（PolarDB Serverless）。DDL 见 schema.sql，部署前对真库冒烟（§五）。 */
export class PgAuthStore implements AuthStore {
  constructor(private pool: Pool) {}

  async createActiveUser(input: { id: string; email: string; now: number }): Promise<UserRecord> {
    try {
      const res = await this.pool.query<UserRow>(
        `INSERT INTO users (id, email, email_verified_at, status, entitlement, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', '{}', $3, $3)
         RETURNING *`,
        [input.id, input.email, new Date(input.now)],
      );
      const row = res.rows[0];
      if (!row) throw new Error('createActiveUser: no row returned');
      return toUser(row);
    } catch (e) {
      // 严格匹配 users_email_alive 约束：其他唯一约束冲突（如 id 主键）不该被
      // 静默当成"邮箱已注册"回退复用，必须原样抛出暴露问题
      const pgErr = e as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === 'users_email_alive') {
        throw new UniqueViolationError(`active user exists for email: ${input.email}`);
      }
      throw e;
    }
  }

  async findActiveUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL AND status = 'active'`,
      [email],
    );
    const row = res.rows[0];
    return row ? toUser(row) : null;
  }

  async findActiveUserById(id: string): Promise<UserRecord | null> {
    const res = await this.pool.query<UserRow>(
      `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [id],
    );
    const row = res.rows[0];
    return row ? toUser(row) : null;
  }

  async softDeleteUser(id: string, now: number): Promise<void> {
    await this.pool.query(`UPDATE users SET deleted_at = $2, updated_at = $2 WHERE id = $1`, [
      id,
      new Date(now),
    ]);
  }

  async insertCode(code: AuthCodeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_codes (id, email, code_hash, expires_at, attempts, consumed_at, ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        code.id,
        code.email,
        code.codeHash,
        new Date(code.expiresAt),
        code.attempts,
        code.consumedAt === null ? null : new Date(code.consumedAt),
        code.ip,
        new Date(code.createdAt),
      ],
    );
  }

  async latestCodeForEmail(email: string): Promise<AuthCodeRecord | null> {
    // id 决胜与内存实现一致：ULID 时间有序，同毫秒插入取最新一条
    const res = await this.pool.query<CodeRow>(
      `SELECT * FROM auth_codes WHERE email = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [email],
    );
    const row = res.rows[0];
    return row ? toCode(row) : null;
  }

  async countCodesForEmailSince(email: string, since: number): Promise<number> {
    return this.countCodesBy('email', email, since);
  }

  async oldestCodeForEmailSince(email: string, since: number): Promise<number | null> {
    return this.oldestCodeBy('email', email, since);
  }

  async countCodesForIpSince(ip: string, since: number): Promise<number> {
    return this.countCodesBy('ip', ip, since);
  }

  async oldestCodeForIpSince(ip: string, since: number): Promise<number | null> {
    return this.oldestCodeBy('ip', ip, since);
  }

  // 限频窗口查询：email/ip 两列同构，列名走白名单字面量（不做参数拼接，无注入面）

  private async countCodesBy(column: 'email' | 'ip', value: string, since: number): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM auth_codes WHERE ${column} = $1 AND created_at >= $2`,
      [value, new Date(since)],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  private async oldestCodeBy(column: 'email' | 'ip', value: string, since: number): Promise<number | null> {
    const res = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at FROM auth_codes WHERE ${column} = $1 AND created_at >= $2
       ORDER BY created_at ASC LIMIT 1`,
      [value, new Date(since)],
    );
    const row = res.rows[0];
    return row ? row.created_at.getTime() : null;
  }

  async consumeCode(codeId: string, now: number): Promise<boolean> {
    // 原子一次性：仅未消费的行能置位成功
    const res = await this.pool.query(
      `UPDATE auth_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [codeId, new Date(now)],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async incrementCodeAttempts(codeId: string): Promise<number> {
    const res = await this.pool.query<{ attempts: number }>(
      `UPDATE auth_codes SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts`,
      [codeId],
    );
    return Number(res.rows[0]?.attempts ?? 0);
  }

  async insertRefreshToken(token: RefreshTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, device_hint, created_at, expires_at, revoked_at, replaced_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        token.id,
        token.userId,
        token.tokenHash,
        token.deviceHint,
        new Date(token.createdAt),
        new Date(token.expiresAt),
        token.revokedAt === null ? null : new Date(token.revokedAt),
        token.replacedBy,
      ],
    );
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const res = await this.pool.query<TokenRow>(
      `SELECT * FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    return row ? toToken(row) : null;
  }

  async findRefreshTokenById(id: string): Promise<RefreshTokenRecord | null> {
    const res = await this.pool.query<TokenRow>(`SELECT * FROM refresh_tokens WHERE id = $1`, [id]);
    const row = res.rows[0];
    return row ? toToken(row) : null;
  }

  async revokeRefreshToken(id: string, now: number, replacedBy: string | null): Promise<boolean> {
    // 条件 UPDATE 保证原子性：并发轮换/登出只有一方 rowCount > 0，
    // 后到一方拿 false 走重放判定路径（service.refresh）
    const res = await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [id, new Date(now), replacedBy],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async revokeAllUserTokens(userId: string, now: number): Promise<void> {
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, new Date(now)],
    );
  }
}
