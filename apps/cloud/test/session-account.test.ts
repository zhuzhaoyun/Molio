import assert from 'node:assert/strict';
import test from 'node:test';
import { del, get, post, register, setup } from './helpers.js';

test('me: 返回用户 + 权益桩', async () => {
  const { app } = setup();
  const reg = await register(app);
  const res = await get(app, '/auth/me', { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { id: string }; entitlement: Record<string, unknown> };
  assert.equal(body.user.id, reg.user.id);
  assert.deepEqual(body.entitlement, {});
});

test('me: 无 token / 篡改 token → 401', async () => {
  const { app } = setup();
  const reg = await register(app);
  assert.equal((await get(app, '/auth/me')).status, 401);
  const tampered = reg.accessToken.slice(0, -2) + 'xx';
  assert.equal((await get(app, '/auth/me', { authorization: `Bearer ${tampered}` })).status, 401);
});

test('me: access token 过期（15 分钟）→ 401', async () => {
  const { app, clock } = setup();
  const reg = await register(app);
  clock.advance(15 * 60 * 1000 + 1000);
  const res = await get(app, '/auth/me', { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(res.status, 401);
});

test('logout: 吊销当前设备 refresh；未重放前其他设备不受影响', async () => {
  const { app, clock } = setup();
  const dev1 = await register(app, 'two@example.com');
  clock.advance(61_000);
  const dev2 = await register(app, 'two@example.com');

  const out = await del(app, '/auth/session', { refreshToken: dev1.refreshToken }, {
    authorization: `Bearer ${dev1.accessToken}`,
  });
  assert.equal(out.status, 200);

  // 设备 2 仍可正常续期（logout 只吊销当前设备）
  const keep = await post(app, '/auth/refresh', { refreshToken: dev2.refreshToken });
  assert.equal(keep.status, 200);

  // 设备 1 的 refresh 已失效
  const gone = await post(app, '/auth/refresh', { refreshToken: dev1.refreshToken });
  assert.equal(gone.status, 401);
});

test('account: 注销 = 软删除 + 吊销全部 session；me 立即失效；同邮箱再注册为新账号', async () => {
  const { app, clock } = setup();
  const reg = await register(app, 'bye@example.com');

  const res = await del(app, '/auth/account', undefined, { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });

  // refresh 被吊销
  const refreshRes = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(refreshRes.status, 401);

  // access 未到期但用户已注销 → me 401
  const meRes = await get(app, '/auth/me', { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(meRes.status, 401);

  // 注销后同邮箱再注册 → 新账号（§二拍板 / §十七 L8）
  clock.advance(61_000);
  const again = await register(app, 'bye@example.com');
  assert.notEqual(again.user.id, reg.user.id);
});

test('session/account: 无 Bearer → 401', async () => {
  const { app } = setup();
  assert.equal((await del(app, '/auth/session', { refreshToken: 'x' })).status, 401);
  assert.equal((await del(app, '/auth/account')).status, 401);
});

test('logout: 归属校验——他人 token 静默忽略，不得越权吊销', async () => {
  const { app, clock } = setup();
  const a = await register(app, 'a@example.com');
  clock.advance(61_000); // 越过重发间隔
  const b = await register(app, 'b@example.com');

  // a 用自己的 access token 尝试吊销 b 的 session
  const out = await del(app, '/auth/session', { refreshToken: b.refreshToken }, {
    authorization: `Bearer ${a.accessToken}`,
  });
  assert.equal(out.status, 200);
  assert.deepEqual(await out.json(), { ok: true });

  // b 的会话不受影响；a 自己的会话也不受影响
  assert.equal((await post(app, '/auth/refresh', { refreshToken: b.refreshToken })).status, 200);
  assert.equal((await post(app, '/auth/refresh', { refreshToken: a.refreshToken })).status, 200);
});

test('me: Bearer scheme 大小写不敏感（RFC 9110）', async () => {
  const { app } = setup();
  const reg = await register(app);
  const res = await get(app, '/auth/me', { authorization: `bearer ${reg.accessToken}` });
  assert.equal(res.status, 200);
});

test('handleError: 非 ServiceError 异常 → 结构化 internal/500（绝不漏纯文本 500）', async () => {
  const { app, service } = setup();
  const reg = await register(app);
  // 制造一个契约外异常（如 DB 驱动错误）
  service.me = async () => {
    throw new Error('pg pool exploded');
  };
  const res = await get(app, '/auth/me', { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'internal' });
});

test('health: 返回 ok + 环境 + 存储类型', async () => {
  const { app } = setup();
  const res = await get(app, '/health');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, env: 'daily', store: 'memory' });
});
