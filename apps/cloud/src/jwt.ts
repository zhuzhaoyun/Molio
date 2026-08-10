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

/** 校验签名与 exp；任何失败返回 null */
export function verifyAccessToken(token: string, secret: string, nowSec: number): AccessPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts as [string, string, string];

  const expected = createHmac('sha256', secret).update(`${h}.${p}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const pl = payload as Partial<AccessPayload>;
  if (typeof pl.sub !== 'string' || typeof pl.exp !== 'number') return null;
  if (pl.exp <= nowSec) return null;
  return payload as AccessPayload;
}
