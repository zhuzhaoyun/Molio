import { existsSync } from 'node:fs';
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

/**
 * 宽限天数上界（≈100 年）。不设上界时 `1e308` 之类误配会让 graceMs 溢出成
 * Infinity——快照"永远在宽限期内"，等于离线白嫖无期限。整数下界 1 防
 * 0.5 取整成 0 把宽限直接关死。
 */
export const MAX_GRACE_DAYS = 36_500;

function isValidGraceDays(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_GRACE_DAYS;
}

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
  // 严格整数校验（不取整）：'0.5' 取整成 0 会静默关死宽限，'1e308' 溢出成 Infinity
  return isValidGraceDays(n) ? n : null;
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
    // 显式传参非法 = 编程错误，直接抛（env 非法则静默回退默认）
    if (opts.graceDays !== undefined && !isValidGraceDays(opts.graceDays)) {
      throw new RangeError(
        `EntitlementCache: graceDays 必须是 [1, ${MAX_GRACE_DAYS}] 内的整数，收到 ${opts.graceDays}`,
      );
    }
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
    // removeCredentials 吞错：删除失败（权限/占用）时旧快照会在重启后复活并继续
    // 通过宽限校验。补写一个 validateSnapshot 必拒的墓碑，保证"登出即失效"。
    if (existsSync(this.file)) {
      try {
        writeCredentials(this.file, { tombstone: true });
      } catch {
        // 尽力而为
      }
    }
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
  // updatedAt 必须有限正数：JSON `1e999` 解析成 Infinity 时
  // `now - Infinity = -Infinity < graceMs` 恒成立 = 永久宽限（白嫖漏洞）
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt <= 0) {
    return null;
  }
  if (!r.user || typeof r.user !== 'object') return null;
  const u = r.user as Partial<User>;
  if (typeof u.id !== 'string' || !u.id) return null;
  if (typeof u.email !== 'string' || !u.email) return null;
  if (typeof u.createdAt !== 'string' || !u.createdAt) return null;
  const user: User = { id: u.id, email: u.email, createdAt: u.createdAt };
  // 与 token-store.validateTokens 一致：nickname 仅 string 时放行（旧快照无此字段）
  if (typeof u.nickname === 'string') user.nickname = u.nickname;
  return {
    user,
    entitlement:
      r.entitlement && typeof r.entitlement === 'object'
        ? (r.entitlement as Entitlement)
        : {},
    updatedAt: r.updatedAt,
  };
}
