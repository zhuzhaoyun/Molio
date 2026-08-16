// AuthStore 持久层抽象（§五）：PgAuthStore（生产）+ MemoryAuthStore（node:test）。
// 时间戳在接口层统一为 epoch 毫秒（number），PG 实现负责与 TIMESTAMPTZ 互转。
// 活跃账号判定收口在 store 内：deleted_at IS NULL AND status = 'active'（§五设计要点）。

/** 并发注册兜底：活跃邮箱唯一约束冲突（§五设计要点，verify 捕获后回退复用已有账号） */
export class UniqueViolationError extends Error {
  constructor(message = 'unique violation') {
    super(message);
    this.name = 'UniqueViolationError';
  }
}

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: number | null;
  status: 'active' | 'deactivated';
  entitlement: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface AuthCodeRecord {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: number;
  attempts: number;
  consumedAt: number | null;
  ip: string | null;
  createdAt: number;
}

export interface RefreshTokenRecord {
  /** token id，即 access JWT 的 jti */
  id: string;
  userId: string;
  tokenHash: string;
  deviceHint: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  /** 轮换产生的新 token id（审计链 + 宽限窗重放追踪）；人工登出时为 null */
  replacedBy: string | null;
}

export interface AuthStore {
  // ── users ──
  /** 活跃邮箱已存在时抛 UniqueViolationError（部分唯一索引 users_email_alive） */
  createActiveUser(input: { id: string; email: string; now: number }): Promise<UserRecord>;
  findActiveUserByEmail(email: string): Promise<UserRecord | null>;
  findActiveUserById(id: string): Promise<UserRecord | null>;
  /** 软删除：置 deleted_at。此后 find* 一律查不到该账号（活跃判定收口于 find* 查询） */
  softDeleteUser(id: string, now: number): Promise<void>;

  // ── auth_codes（限频全部走查询，FC 多实例无内存限流，§五） ──
  insertCode(code: AuthCodeRecord): Promise<void>;
  latestCodeForEmail(email: string): Promise<AuthCodeRecord | null>;
  countCodesForEmailSince(email: string, since: number): Promise<number>;
  /** 窗口内最早一条的创建时间（计算每日上限的解锁时刻） */
  oldestCodeForEmailSince(email: string, since: number): Promise<number | null>;
  countCodesForIpSince(ip: string, since: number): Promise<number>;
  oldestCodeForIpSince(ip: string, since: number): Promise<number | null>;
  /** 原子置位 consumed_at；true = 本次调用完成消费（一次性保证），false = 已被消费 */
  consumeCode(codeId: string, now: number): Promise<boolean>;
  /** 错误次数 +1，返回新值 */
  incrementCodeAttempts(codeId: string): Promise<number>;

  // ── refresh_tokens ──
  insertRefreshToken(token: RefreshTokenRecord): Promise<void>;
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  findRefreshTokenById(id: string): Promise<RefreshTokenRecord | null>;
  /** 原子吊销：仅未吊销的 token 生效。true = 本次调用完成吊销，false = 已被吊销（并发/重放） */
  revokeRefreshToken(id: string, now: number, replacedBy: string | null): Promise<boolean>;
  /** 吊销该用户全部未吊销 session（重放检测 / 注销账号） */
  revokeAllUserTokens(userId: string, now: number): Promise<void>;
}
