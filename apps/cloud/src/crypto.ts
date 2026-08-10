import { createHash, randomBytes, randomInt } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 验证码 hash：SHA-256(code + pepper)，不存明文（§八） */
export function hashCode(code: string, pepper: string): string {
  return sha256Hex(`${code}:${pepper}`);
}

/** refresh token hash：SHA-256，不存明文（§八） */
export function hashRefreshToken(token: string): string {
  return sha256Hex(token);
}

/** 256-bit 随机 refresh token（hex 编码） */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

/** 6 位数字验证码 */
export function generateAuthCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 轻量 ULID：48-bit 毫秒时间戳（10 字符）+ 80-bit 随机（16 字符） */
export function ulid(nowMs: number = Date.now()): string {
  let ts = nowMs % 0x1_0000_0000_0000;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = (CROCKFORD[ts % 32] ?? '0') + time;
    ts = Math.floor(ts / 32);
  }
  // 80-bit 随机段 = 16 个 base32 字符（字节 % 32 无取模偏差：256 = 32 × 8）
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[(bytes[i] ?? 0) % 32] ?? '0';
  return time + rand;
}
