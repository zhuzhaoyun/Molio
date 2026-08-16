import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { ulid } from '../src/crypto.js';
import { signAccessToken, verifyAccessToken, type AccessPayload } from '../src/jwt.js';

const SECRET = 'unit-test-secret';

function payload(exp: number): AccessPayload {
  return { sub: 'user-1', email: 'u@example.com', jti: 'token-1', iat: 0, exp };
}

function b64url(input: unknown): string {
  return Buffer.from(typeof input === 'string' ? input : JSON.stringify(input), 'utf8').toString('base64url');
}

/** 伪造任意 header/payload 的 token（用真密钥签名，专测结构校验而非签名校验） */
function forge(header: unknown, body: unknown): string {
  const h = b64url(header);
  const p = b64url(body);
  const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

test('jwt: sign/verify 往返一致', () => {
  const token = signAccessToken(payload(1000), SECRET);
  const got = verifyAccessToken(token, SECRET, 999);
  assert.ok(got);
  assert.equal(got!.sub, 'user-1');
  assert.equal(got!.jti, 'token-1');
});

test('jwt: 已过期 → null', () => {
  const token = signAccessToken(payload(1000), SECRET);
  assert.equal(verifyAccessToken(token, SECRET, 1000), null);
  assert.equal(verifyAccessToken(token, SECRET, 1001), null);
});

test('jwt: 错误密钥 / 篡改签名 → null', () => {
  const token = signAccessToken(payload(1000), SECRET);
  assert.equal(verifyAccessToken(token, 'other-secret', 0), null);
  const tampered = token.slice(0, -2) + 'xx';
  assert.equal(verifyAccessToken(tampered, SECRET, 0), null);
});

test('jwt: 结构非法 → null', () => {
  assert.equal(verifyAccessToken('not-a-jwt', SECRET, 0), null);
  assert.equal(verifyAccessToken('a.b', SECRET, 0), null);
});

test('jwt: 带 kid 头可正常签发校验（L6 留桩）', () => {
  const token = signAccessToken(payload(1000), SECRET, 'kid-2026-08');
  const got = verifyAccessToken(token, SECRET, 0);
  assert.ok(got);
  const header = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
  assert.equal(header.kid, 'kid-2026-08');
});

test('jwt: header alg 非 HS256（none / RS256 / 缺失）→ null', () => {
  const pl = payload(1000);
  assert.equal(verifyAccessToken(forge({ alg: 'none', typ: 'JWT' }, pl), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge({ alg: 'RS256', typ: 'JWT' }, pl), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge({ typ: 'JWT' }, pl), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge(null, pl), SECRET, 0), null);
});

test('jwt: payload 缺任一必需 claim → null', () => {
  const base = payload(1000);
  for (const key of ['sub', 'email', 'jti', 'iat', 'exp'] as const) {
    const broken = { ...base, [key]: undefined };
    assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, broken), SECRET, 0), null, `missing ${key}`);
  }
  // 类型不对同样拒绝（sub 是数字）
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, { ...base, sub: 42 }), SECRET, 0), null);
});

test('jwt: payload 非对象（null / 原始值 / 数组）→ null', () => {
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, null), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, 42), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, 'just-a-string'), SECRET, 0), null);
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, [1, 2]), SECRET, 0), null);
});

test('jwt: payload JSON 非法 → null', () => {
  // 传入原始字符串 → 不包 JSON 引号 → JSON.parse 失败路径
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, '{not-json'), SECRET, 0), null);
});

test('jwt: exp 非有限数（1e999 → Infinity）→ null（永不过期漏洞）', () => {
  // JSON.parse('1e999') = Infinity：Infinity <= nowSec 恒为 false，不拒绝即永不过期。
  // 手写 JSON 构造（JSON.stringify 会把 Infinity 折成 null，测不到该路径）
  const inf = '{"sub":"u","email":"e@x.com","jti":"t","iat":0,"exp":1e999}';
  assert.equal(verifyAccessToken(forge({ alg: 'HS256' }, inf), SECRET, 0), null);
});

test('ulid: 26 字符且时间前缀单调', () => {
  const a = ulid(1_000_000_000_000);
  const b = ulid(1_000_000_000_001);
  assert.equal(a.length, 26);
  assert.equal(b.length, 26);
  assert.ok(a < b, 'ULID 应按时间字典序递增');
});
