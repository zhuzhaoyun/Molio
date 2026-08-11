import path from 'node:path';
import type { User } from '@molio/contracts';
import {
  configDir,
  readCredentialsRaw,
  writeCredentials,
  removeCredentials,
} from '../channels/credentials-store.js';
import {
  decryptWithDesktop,
  encryptWithDesktop,
  isDesktopCryptoConfigured,
} from './desktop-crypto.js';

/**
 * Molio 账号 token 持久化（设计 §六/§八）。
 *
 * 落盘位置 `~/.molio/auth-tokens.json`，复用跨渠道 credentials-store 的 I/O
 * （.tmp + rename 原子写、POSIX chmod 0o600、防御性解析）。
 *
 * 两种落盘格式（按字段判别）：
 * - **明文**：AuthTokens JSON 对象本身（accessToken 在顶层）。非桌面模式基线（D3）。
 * - **信封**：`{ v: 1, encrypted: "<base64>" }`，内层是 AuthTokens JSON。桌面模式
 *   经 Electron 主进程 safeStorage 加密（daemon 以 ELECTRON_RUN_AS_NODE 运行拿不到
 *   Electron API，走 desktop-crypto.ts 的本机 HTTP RPC；端口 env 缺失即非桌面模式）。
 *
 * 迁移规则：
 * - 明文文件在桌面模式照读，下次写自动升级为信封。
 * - 信封在未配置 crypto 的 daemon（dev/Docker/独立）上读作 null（视为未登录，
 *   **不删文件**）；该 daemon 新登录会明文覆盖（它本就读不了信封，合法基线）。
 * - 解密失败（服务暂挂/文件跨机器复制）同样读作 null 不删文件，可恢复。
 *
 * 写降级规则（按模式判定，不按磁盘状态）：配置了 crypto 但加密失败 → **跳过落盘**
 * 保内存（绝不静默降级明文）；未配置 crypto → 一律明文。
 *
 * token 刻意**不进 config.json**：config.json 是可能被同步/分享的配置文件，
 * token 是凭证（§八 D3）。
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

/** 桌面端加密落盘格式。v 留版本号以便将来换算法。 */
export interface EncryptedEnvelope {
  v: 1;
  /** base64(safeStorage.encryptString(明文 AuthTokens JSON))。 */
  encrypted: string;
}

/** 加解密提供方抽象：默认接 desktop-crypto（env 缺失时自动 no-op），测试可替换。 */
export interface TokenCryptoProvider {
  /** crypto 服务是否已配置（桌面模式 = MOLIO_DESKTOP_CRYPTO_PORT 存在）。 */
  isConfigured(): boolean;
  /** 加密失败返回 null（从不抛错）。 */
  encrypt(plaintext: string): Promise<string | null>;
  /** 解密失败返回 null（从不抛错）。 */
  decrypt(data: string): Promise<string | null>;
}

const defaultCryptoProvider: TokenCryptoProvider = {
  isConfigured: isDesktopCryptoConfigured,
  encrypt: encryptWithDesktop,
  decrypt: decryptWithDesktop,
};

let cryptoProvider: TokenCryptoProvider = defaultCryptoProvider;

/** 替换 crypto provider（测试注入用）。返回恢复原 provider 的函数。 */
export function setTokenCryptoProvider(p: TokenCryptoProvider): () => void {
  const prev = cryptoProvider;
  cryptoProvider = p;
  return () => {
    cryptoProvider = prev;
  };
}

function isEnvelope(raw: unknown): raw is EncryptedEnvelope {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Partial<EncryptedEnvelope>;
  return r.v === 1 && typeof r.encrypted === 'string' && r.encrypted.length > 0;
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

/**
 * 读取本地 token（异步：桌面模式需 RPC 解密）。
 * 文件缺失/损坏/字段不全/解密失败一律返回 null（视为未登录），**从不删文件**。
 */
export async function readAuthTokens(): Promise<AuthTokens | null> {
  const rawText = readCredentialsRaw(authTokensPath());
  if (rawText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return null;
  }
  if (isEnvelope(parsed)) {
    // 信封：独立/dev daemon（未配置 crypto）读不了 → null；桌面模式走解密。
    if (!cryptoProvider.isConfigured()) return null;
    const plaintext = await cryptoProvider.decrypt(parsed.encrypted);
    if (plaintext === null) return null; // 服务暂挂 / 跨机器复制 → 不删文件，可恢复
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return null;
    }
  }
  return validateTokens(parsed);
}

/** 写入结果：落盘成功（明文或信封）；或配置了 crypto 但加密失败 → 跳过落盘。 */
export type WriteTokensResult =
  | { written: true; encrypted: boolean }
  | { written: false; reason: 'encrypt_failed' };

/**
 * 写入 token（异步：桌面模式需 RPC 加密）。
 *
 * - 配置 crypto + 加密成功 → 写信封 `{v:1, encrypted}`
 * - 配置 crypto + 加密失败 → **跳过落盘**（返回 written:false，调用方保留内存
 *   token；绝不静默写明文弱化保护）
 * - 未配置 crypto → 明文（现状基线）
 *
 * 文件系统错误仍会抛（沿用 writeCredentials 约定）——落盘失败调用方需知晓。
 */
export async function writeAuthTokens(tokens: AuthTokens): Promise<WriteTokensResult> {
  if (cryptoProvider.isConfigured()) {
    const data = await cryptoProvider.encrypt(JSON.stringify(tokens));
    if (data === null) {
      return { written: false, reason: 'encrypt_failed' };
    }
    const envelope: EncryptedEnvelope = { v: 1, encrypted: data };
    writeCredentials(authTokensPath(), envelope);
    return { written: true, encrypted: true };
  }
  writeCredentials(authTokensPath(), tokens);
  return { written: true, encrypted: false };
}

/** 删除本地 token（尽力而为，不抛）。同步——纯文件删除，不涉及 crypto。 */
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
