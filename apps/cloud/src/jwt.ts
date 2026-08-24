import { createHmac, timingSafeEqual } from 'node:crypto';

/** Access Token payload（§六 Token 规格：HS256，15 分钟） */
export interface AccessPayload {
  /** userId */
  sub: string;
  email: string;
  /** 关联的 refresh token id */
  jti: string;
  /** 签发时间（unix 秒） */
  iat: number;
  /** 过期时间（unix 秒） */
  exp: number;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function signAccessToken(payload: AccessPayload, secret: string, kid?: string): string {
  const header: Record<string, string> = { alg: 'HS256', typ: 'JWT' };
  if (kid) header.kid = kid;
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

/** 校验 header alg、签名与 exp；任何失败返回 null */
export function verifyAccessToken(token: string, secret: string, nowSec: number): AccessPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  // header 必须显式声明 HS256：防 alg=none / 算法混淆攻击
  // （当前单密钥下无实际影响，但 kid 留桩将来引入多密钥时是必要防线）
  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header === null || typeof header !== 'object' || (header as { alg?: unknown }).alg !== 'HS256') {
    return null;
  }

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  // Node 的 base64url 解码对非法字符静默忽略不抛错，长度 + timingSafeEqual 即完整防线
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // JSON.parse 可能产出 null / 原始值，先收窄为对象再读字段
  if (payload === null || typeof payload !== 'object') return null;
  const pl = payload as Partial<AccessPayload>;
  // 全部必需 claims 逐一校验：缺失即拒绝，返回类型才与 AccessPayload 一致
  if (
    typeof pl.sub !== 'string' ||
    typeof pl.email !== 'string' ||
    typeof pl.jti !== 'string' ||
    typeof pl.iat !== 'number' ||
    typeof pl.exp !== 'number'
  ) {
    return null;
  }
  // NaN/Infinity 也是 number：NaN <= x 恒为 false、Infinity 永不过期，必须显式拒绝
  if (!Number.isFinite(pl.iat) || !Number.isFinite(pl.exp)) return null;
  if (pl.exp <= nowSec) return null;
  return pl as AccessPayload;
}
