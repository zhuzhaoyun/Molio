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

/**
 * 隐式注册自动昵称：「墨友」+ 4 位随机数（如「墨友0421」）。
 * 昵称只是显示名，不做唯一性约束（重名无害，用户可随时经 PATCH /auth/me 修改）。
 */
export function generateNickname(): string {
  return `墨友${randomInt(0, 10_000).toString().padStart(4, '0')}`;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 轻量 ULID：48-bit 毫秒时间戳（10 字符）+ 80-bit 随机（16 字符） */
export function ulid(nowMs: number = Date.now()): string {
  let ts = nowMs % 0x1_0000_0000_0000;
  let time = '';
  for (let i = 0; i < 10; i++) {
    // CROCKFORD 恒为 32 字符，索引恒在 [0,31]：无需 ?? 兜底
    time = CROCKFORD[ts % 32] + time;
    ts = Math.floor(ts / 32);
  }
  // 80-bit 随机段 = 16 个 base32 字符：16 字节各取低 5 bit（% 32 无取模偏差，256 = 32 × 8），
  // 16 × 5 bit = 80 bit 熵恰好填满 16 字符容量（每字节高 3 bit 是逐字节 base32 的固有开销）
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return time + rand;
}
