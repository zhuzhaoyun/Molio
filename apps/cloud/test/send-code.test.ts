import assert from 'node:assert/strict';
import test from 'node:test';
import { post, setup } from './helpers.js';

test('send-code: 202 + ok + resendAfterSec + devCode（daily 模式）', async () => {
  const { app } = setup();
  const res = await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { ok: boolean; resendAfterSec: number; devCode?: string };
  assert.equal(body.ok, true);
  assert.equal(body.resendAfterSec, 60);
  assert.match(body.devCode ?? '', /^\d{6}$/);
});

test('send-code: 防枚举——全新邮箱也返回 202，不泄露注册状态', async () => {
  const { app } = setup();
  const res = await post(app, '/auth/send-code', { email: 'never-seen@example.com' });
  assert.equal(res.status, 202);
});

test('send-code: prod 模式严格不返回 devCode', async () => {
  const { app } = setup({ env: 'prod' });
  const res = await post(app, '/auth/send-code', { email: 'user@example.com' });
  assert.equal(res.status, 202);
  const body = (await res.json()) as { devCode?: string };
  assert.equal(body.devCode, undefined);
});

test('send-code: 60s 重发间隔内 → 429 rate_limited，附剩余秒数', async () => {
  const { app, clock } = setup();
  await post(app, '/auth/send-code', { email: 'a@example.com' });
  clock.advance(30_000);
  const res = await post(app, '/auth/send-code', { email: 'a@example.com' });
  assert.equal(res.status, 429);
  const body = (await res.json()) as { error: string; resendAfterSec: number };
  assert.equal(body.error, 'rate_limited');
  assert.equal(body.resendAfterSec, 30);
});

test('send-code: 重发间隔过后可再次发送', async () => {
  const { app, clock } = setup();
  await post(app, '/auth/send-code', { email: 'a@example.com' });
  clock.advance(61_000);
  const res = await post(app, '/auth/send-code', { email: 'a@example.com' });
  assert.equal(res.status, 202);
});

test('send-code: 每邮箱每日上限 → 429', async () => {
  const { app, clock } = setup({ rate: { emailResendSec: 60, emailDailyMax: 2, ipDailyMax: 100 } });
  assert.equal((await post(app, '/auth/send-code', { email: 'a@example.com' })).status, 202);
  clock.advance(61_000);
  assert.equal((await post(app, '/auth/send-code', { email: 'a@example.com' })).status, 202);
  clock.advance(61_000);
  const res = await post(app, '/auth/send-code', { email: 'a@example.com' });
  assert.equal(res.status, 429);
  assert.equal(((await res.json()) as { error: string }).error, 'rate_limited');
});

test('send-code: 每 IP 每日上限 → 429（换邮箱也拦）', async () => {
  const { app, clock } = setup({ rate: { emailResendSec: 60, emailDailyMax: 10, ipDailyMax: 1 } });
  const h = { 'x-forwarded-for': '1.2.3.4' };
  assert.equal((await post(app, '/auth/send-code', { email: 'a@example.com' }, h)).status, 202);
  clock.advance(61_000);
  const res = await post(app, '/auth/send-code', { email: 'b@example.com' }, h);
  assert.equal(res.status, 429);
});

test('send-code: 非法邮箱 → 400 invalid_email', async () => {
  const { app } = setup();
  const res = await post(app, '/auth/send-code', { email: 'not-an-email' });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_email');
});

test('send-code: 邮箱大小写归一化——同邮箱不同大小写命中同一限频', async () => {
  const { app } = setup();
  assert.equal((await post(app, '/auth/send-code', { email: 'Foo@Example.com' })).status, 202);
  const res = await post(app, '/auth/send-code', { email: 'foo@example.com' });
  assert.equal(res.status, 429);
});
