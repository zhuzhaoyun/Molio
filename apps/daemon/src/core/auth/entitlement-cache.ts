import path from 'node:path';
import type { Entitlement, User } from '@molio/contracts';
import {
  configDir,
  readCredentials,
  writeCredentials,
  removeCredentials,
} from '../channels/credentials-store.js';

/** 离线宽限默认 7 天（设计 §九：太松=白嫖漏洞，太紧=体验差；做成配置项）。 */
export const DEFAULT_GRACE_DAYS = 7;

/** 权益快照：云端可达时由 /auth/me 刷新，不可达时本地宽限的数据来源。 */
export interface EntitlementSnapshot {
  user: User;
  entitlement: Entitlement;
  /** 最近一次成功从云端取回该快照的时刻（epoch ms）。 */
  updatedAt: number;
}

export interface EntitlementCacheOptions {
  /** 宽限天数覆盖；缺省读 env MOLIO_AUTH_GRACE_DAYS，再缺省 7。 */
  graceDays?: number;
  /** 存储文件覆盖（测试用）；缺省 ~/.molio/entitlement-cache.json。 */
  file?: string;
}

function envGraceDays(): number | null {
  const raw = process.env['MOLIO_AUTH_GRACE_DAYS'];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 权益快照缓存（设计 §九 离线宽限策略）。
 *
 * 云端不可达时，付费功能凭本地快照在宽限期内继续可用；宽限期过 → 降级提示
 * 而非锁死。快照内存懒加载一次，写盘走 credentials-store 原子写。
 */
export class EntitlementCache {
  private cached: EntitlementSnapshot | null | undefined = undefined;
  private readonly file: string;
  readonly graceMs: number;

  constructor(opts: EntitlementCacheOptions = {}) {
    const days = opts.graceDays ?? envGraceDays() ?? DEFAULT_GRACE_DAYS;
    this.graceMs = days * 24 * 60 * 60 * 1000;
    this.file = opts.file ?? path.join(configDir(), 'entitlement-cache.json');
  }

  /** 读快照（内存优先，首次从磁盘懒加载）；缺失/损坏返回 null。 */
  read(): EntitlementSnapshot | null {
    if (this.cached === undefined) {
      this.cached = readCredentials<EntitlementSnapshot>(this.file, validateSnapshot);
    }
    return this.cached;
  }

  /** 刷新快照（云端 /auth/me 成功后调用）。 */
  write(snap: EntitlementSnapshot): void {
    writeCredentials(this.file, snap);
    this.cached = snap;
  }

  /** 清除快照（登出 / refresh 被云端吊销时）。尽力而为。 */
  clear(): void {
    removeCredentials(this.file);
    this.cached = null;
  }

  /** 快照是否仍在宽限期内（now 可注入，测试用）。 */
  isWithinGrace(snap: EntitlementSnapshot, now: number = Date.now()): boolean {
    return now - snap.updatedAt < this.graceMs;
  }

  /** 宽限剩余 ms（≤0 = 已过期）。 */
  graceRemainingMs(snap: EntitlementSnapshot, now: number = Date.now()): number {
    return this.graceMs - (now - snap.updatedAt);
  }
}

function validateSnapshot(raw: unknown): EntitlementSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<EntitlementSnapshot>;
  if (typeof r.updatedAt !== 'number' || !r.updatedAt) return null;
  if (!r.user || typeof r.user !== 'object') return null;
  const u = r.user as Partial<User>;
  if (typeof u.id !== 'string' || !u.id) return null;
  if (typeof u.email !== 'string' || !u.email) return null;
  if (typeof u.createdAt !== 'string' || !u.createdAt) return null;
  return {
    user: { id: u.id, email: u.email, createdAt: u.createdAt },
    entitlement:
      r.entitlement && typeof r.entitlement === 'object'
        ? (r.entitlement as Entitlement)
        : {},
    updatedAt: r.updatedAt,
  };
}
