import path from 'node:path';
import type { User } from '@molio/contracts';
import {
  configDir,
  readCredentials,
  writeCredentials,
  removeCredentials,
} from '../channels/credentials-store.js';

/**
 * Molio 账号 token 持久化（设计 §六/§八）。
 *
 * 落盘位置 `~/.molio/auth-tokens.json`，复用跨渠道 credentials-store 的 I/O
 * （.tmp + rename 原子写、POSIX chmod 0o600、防御性 JSON 解析）。
 *
 * token 刻意**不进 config.json**：config.json 是可能被同步/分享的配置文件，
 * token 是凭证；且 Windows 上 chmod 无意义时，token 文件与 SQLite/config 同
 * 信任级（本机单用户模型），单独成文件便于桌面端将来换 safeStorage（§八 D3）。
 */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user: User;
  /** access JWT 的 exp（unix ms），落盘时解码得到；用于 <2min 主动刷新。解码失败则缺省。 */
  accessExpiresAt?: number;
  /** 本 token 对落盘时刻（epoch ms）。 */
  savedAt: number;
}

/** 懒计算路径：测试可在 import 后改 USERPROFILE/HOME 重定向。 */
export function authTokensPath(): string {
  return path.join(configDir(), 'auth-tokens.json');
}

function validateTokens(raw: unknown): AuthTokens | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AuthTokens>;
  if (typeof r.accessToken !== 'string' || !r.accessToken) return null;
  if (typeof r.refreshToken !== 'string' || !r.refreshToken) return null;
  if (!r.user || typeof r.user !== 'object') return null;
  const u = r.user as Partial<User>;
  if (typeof u.id !== 'string' || !u.id) return null;
  if (typeof u.email !== 'string' || !u.email) return null;
  if (typeof u.createdAt !== 'string' || !u.createdAt) return null;
  const out: AuthTokens = {
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    user: { id: u.id, email: u.email, createdAt: u.createdAt },
    savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
  };
  if (typeof r.accessExpiresAt === 'number') out.accessExpiresAt = r.accessExpiresAt;
  return out;
}

/** 读取本地 token；文件缺失/损坏/字段不全一律返回 null（视为未登录）。 */
export function readAuthTokens(): AuthTokens | null {
  return readCredentials<AuthTokens>(authTokensPath(), validateTokens);
}

/**
 * 原子写入 token。调用方应先写盘成功再更新内存缓存——写失败时抛出让调用方
 * 知晓（否则重启后 token 丢失，见 FeishuTokenStore 同款约定）。
 */
export function writeAuthTokens(tokens: AuthTokens): void {
  writeCredentials(authTokensPath(), tokens);
}

/** 删除本地 token（尽力而为，不抛）。 */
export function clearAuthTokens(): void {
  removeCredentials(authTokensPath());
}

/**
 * 解码 access JWT 的 `exp`（不校验签名——daemon 无云端密钥，签名由云端校验；
 * 这里只用作主动刷新的启发式）。返回 unix ms；格式异常返回 null。
 */
export function decodeAccessExp(accessToken: string): number | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1] as string, 'base64url').toString('utf8'),
    ) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return Math.floor(payload.exp * 1000);
  } catch {
    return null;
  }
}
