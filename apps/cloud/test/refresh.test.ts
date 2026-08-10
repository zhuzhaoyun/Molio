import assert from 'node:assert/strict';
import test from 'node:test';
import { del, post, register, setup } from './helpers.js';

test('refresh: 轮换——发新 token 对，新旧不同', async () => {
  const { app } = setup();
  const reg = await register(app);
  const res = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { accessToken: string; refreshToken: string };
  assert.ok(body.accessToken.length > 0);
  assert.notEqual(body.refreshToken, reg.refreshToken);
});

test('refresh: D1 宽限窗内重放已轮换 token → 视为重试，返回链上新 token 对（不全吊销）', async () => {
  const { app, clock } = setup();
  const reg = await register(app);

  // 正常轮换：R1 → R2（假设响应成功返回）
  const r1 = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(r1.status, 200);
  const r2 = (await r1.json()) as { refreshToken: string };

  // 模拟 daemon 重试：10s 内（<30s 宽限窗）重放 R1
  clock.advance(10_000);
  const replay = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(replay.status, 200);
  const r3 = (await replay.json()) as { refreshToken: string };
  assert.notEqual(r3.refreshToken, r2.refreshToken);

  // 返回的新 token 对可用（链头轮换，未触发全吊销）
  const next = await post(app, '/auth/refresh', { refreshToken: r3.refreshToken });
  assert.equal(next.status, 200);
});

test('refresh: 超宽限窗重放 → 吊销该用户全部 session', async () => {
  const { app, clock } = setup();
  const reg = await register(app);

  const r1 = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  const r2 = (await r1.json()) as { refreshToken: string };

  clock.advance(31_000); // > 30s 宽限窗
  const replay = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(replay.status, 401);

  // 合法的 R2 也被吊销
  const res = await post(app, '/auth/refresh', { refreshToken: r2.refreshToken });
  assert.equal(res.status, 401);
});

test('refresh: 人工登出后重放（无 replaced_by）→ 全吊销，殃及其他设备', async () => {
  const { app, clock } = setup();
  const dev1 = await register(app, 'shared@example.com');
  clock.advance(61_000);
  const dev2 = await register(app, 'shared@example.com');

  // 设备 1 正常登出
  const out = await del(app, '/auth/session', { refreshToken: dev1.refreshToken }, {
    authorization: `Bearer ${dev1.accessToken}`,
  });
  assert.equal(out.status, 200);

  // 登出后的 refresh 再现 → 判定泄漏，全吊销
  const replay = await post(app, '/auth/refresh', { refreshToken: dev1.refreshToken });
  assert.equal(replay.status, 401);

  // 设备 2 被殃及（设计 D1：人工吊销后的重放触发全吊销）
  const res = await post(app, '/auth/refresh', { refreshToken: dev2.refreshToken });
  assert.equal(res.status, 401);
});

test('refresh: refresh 到期（30 天）→ 401，不牵连其他用户 session', async () => {
  const { app, clock } = setup();
  const a = await register(app, 'a@example.com');
  clock.advance(30 * 24 * 60 * 60 * 1000 + 1000);
  // 过期后 b 新建 session
  const b = await register(app, 'b@example.com');

  const resA = await post(app, '/auth/refresh', { refreshToken: a.refreshToken });
  assert.equal(resA.status, 401);

  const resB = await post(app, '/auth/refresh', { refreshToken: b.refreshToken });
  assert.equal(resB.status, 200);
});

test('refresh: 未知 token → 401', async () => {
  const { app } = setup();
  const res = await post(app, '/auth/refresh', { refreshToken: 'nonexistent-token' });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as { error: string }).error, 'invalid_token');
});
