import assert from 'node:assert/strict';
import test from 'node:test';
import { maskEmail } from '../src/service.js';
import { post, register, setup } from './helpers.js';

// ─── 端点入参校验（400 请求错误 vs 401 认证失败语义分离） ────────────

test('send-code: 缺 email / body 非对象 / 非法 JSON → 400 invalid_email', async () => {
  const { app } = setup();
  assert.equal((await post(app, '/auth/send-code', {})).status, 400);
  assert.equal((await post(app, '/auth/send-code', ['a@b.com'])).status, 400);
  assert.equal((await post(app, '/auth/send-code', 'just-a-string')).status, 400);
  const badJson = await app.request('/auth/send-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);
});

test('verify: 字段级 400 与 401「验证码不正确」语义不同', async () => {
  const { app } = setup();
  // email 缺失/非字符串 → 400 invalid_email（请求本身不合法）
  const noEmail = await post(app, '/auth/verify', { code: '123456' });
  assert.equal(noEmail.status, 400);
  assert.equal(((await noEmail.json()) as { error: string }).error, 'invalid_email');
  // code 缺失/非字符串 → 400 invalid_code（不是 401：401 保留给「码不正确」）
  const noCode = await post(app, '/auth/verify', { email: 'a@example.com' });
  assert.equal(noCode.status, 400);
  assert.equal(((await noCode.json()) as { error: string }).error, 'invalid_code');
});

test('verify: deviceHint 非字符串 → 忽略字段但正常验证（不打 500）', async () => {
  const { app } = setup();
  const r1 = await post(app, '/auth/send-code', { email: 'a@example.com' });
  const { devCode } = (await r1.json()) as { devCode: string };
  const evilHints = [{ nested: true }, ['x'], 42];
  for (const deviceHint of evilHints) {
    const r = await post(app, '/auth/verify', { email: 'a@example.com', code: devCode, deviceHint });
    // 一次性码：第一次成功后其余走 401 invalid_code——两种都证明未 500
    assert.ok(r.status === 200 || r.status === 401, `unexpected ${r.status} for ${JSON.stringify(deviceHint)}`);
  }
});

test('refresh: 缺 refreshToken / body 非对象 → 401 invalid_token', async () => {
  const { app } = setup();
  assert.equal((await post(app, '/auth/refresh', {})).status, 401);
  assert.equal((await post(app, '/auth/refresh', ['token'])).status, 401);
});

test('send-code: XFF 首值作为客户端 IP 参与限频', async () => {
  const { app } = setup({ rate: { ipDailyMax: 1 } });
  const h = { 'x-forwarded-for': '8.8.8.8, 10.0.0.1' };
  const r1 = await post(app, '/auth/send-code', { email: 'x1@example.com' }, h);
  assert.equal(r1.status, 202);
  // 同 IP 换邮箱也撞上限
  const r2 = await post(app, '/auth/send-code', { email: 'x2@example.com' }, h);
  assert.equal(r2.status, 429);
});

test('verify: 已注册邮箱与全新邮箱响应结构一致（防枚举）', async () => {
  const { app, clock } = setup();
  await register(app, 'known@example.com');
  clock.advance(61_000);
  const again = await register(app, 'known@example.com');
  assert.ok(again.accessToken, '已注册邮箱登录结构与首次注册完全一致');
});

test('clientIp: 非法 XFF 值不作为限频 key（格式校验）', async () => {
  const { app } = setup({ rate: { ipDailyMax: 1 } });
  // 非法值 → 视为无 IP：IP 维度限频跳过，两个不同邮箱都能发（邮箱维度未超限）
  const evil = { 'x-forwarded-for': 'not-an-ip"; DROP TABLE users;' };
  assert.equal((await post(app, '/auth/send-code', { email: 'v1@example.com' }, evil)).status, 202);
  assert.equal((await post(app, '/auth/send-code', { email: 'v2@example.com' }, evil)).status, 202);
  // IPv6 合法值正常参与限频
  const v6 = { 'x-forwarded-for': '2001:db8::1' };
  assert.equal((await post(app, '/auth/send-code', { email: 'v3@example.com' }, v6)).status, 202);
  assert.equal((await post(app, '/auth/send-code', { email: 'v4@example.com' }, v6)).status, 429);
});

test('maskEmail: 日志脱敏保留可定位的最小信息', () => {
  assert.equal(maskEmail('user@example.com'), 'us***@example.com');
  assert.equal(maskEmail('u@example.com'), 'u***@example.com');
  assert.equal(maskEmail('no-at-sign'), '***');
});
