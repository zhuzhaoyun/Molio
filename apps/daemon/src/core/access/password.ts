import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
const FORMAT = /^scrypt\$32768\$8\$1\$([0-9a-f]{32})\$([0-9a-f]{128})$/;
const OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scryptCallback(password, salt, 64, OPTIONS, (err, key) => {
    if (err) reject(err); else resolve(key);
  }));

export function isValidPasswordHash(value: string): boolean {
  return FORMAT.test(value);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const match = FORMAT.exec(encodedHash);
  if (!match) return false;
  const expected = Buffer.from(match[2]!, 'hex');
  const actual = await scrypt(password, Buffer.from(match[1]!, 'hex'));
  return timingSafeEqual(actual, expected);
}
