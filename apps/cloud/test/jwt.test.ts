import assert from 'node:assert/strict';
import test from 'node:test';
import { ulid } from '../src/crypto.js';
import { signAccessToken, verifyAccessToken, type AccessPayload } from '../src/jwt.js';

const SECRET = 'unit-test-secret';

function payload(exp: number): AccessPayload {
  return { sub: 'user-1', email: 'u@example.com', jti: 'token-1', iat: 0, exp };
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

test('ulid: 26 字符且时间前缀单调', () => {
  const a = ulid(1_000_000_000_000);
  const b = ulid(1_000_000_000_001);
  assert.equal(a.length, 26);
  assert.equal(b.length, 26);
  assert.ok(a < b, 'ULID 应按时间字典序递增');
});
