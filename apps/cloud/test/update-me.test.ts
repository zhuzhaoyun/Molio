import assert from 'node:assert/strict';
import test from 'node:test';
import { get, patch, register, setup } from './helpers.js';

// ─── PATCH /auth/me（修改昵称） ───────────────────────────────────────

test('PATCH /auth/me: 成功改昵称 → MeResponse，GET /auth/me 持久化可见', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');

  const res = await patch(app, '/auth/me', { nickname: '新昵称' }, {
    authorization: `Bearer ${reg.accessToken}`,
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user: { nickname?: string; email: string }; entitlement: unknown };
  assert.equal(body.user.nickname, '新昵称');
  assert.equal(body.user.email, 'a@example.com');

  // 持久化：再次 GET /auth/me 仍是新昵称
  const me = await get(app, '/auth/me', { authorization: `Bearer ${reg.accessToken}` });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { user: { nickname?: string } }).user.nickname, '新昵称');
});

test('PATCH /auth/me: 两端空白被 trim 后存储', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');
  const res = await patch(app, '/auth/me', { nickname: '  hello  ' }, {
    authorization: `Bearer ${reg.accessToken}`,
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { user: { nickname?: string } }).user.nickname, 'hello');
});

test('PATCH /auth/me: 空串 / 纯空白 → 400 invalid_nickname（不支持清空昵称）', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');
  const h = { authorization: `Bearer ${reg.accessToken}` };
  for (const nickname of ['', '   ', '\t\n']) {
    const res = await patch(app, '/auth/me', { nickname }, h);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, 'invalid_nickname');
  }
});

test('PATCH /auth/me: 长度按 Unicode code point 计——20 过、21 拒（emoji 不折半）', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');
  const h = { authorization: `Bearer ${reg.accessToken}` };

  // 20 个纯 ASCII → 通过；21 个 → 拒
  assert.equal((await patch(app, '/auth/me', { nickname: 'a'.repeat(20) }, h)).status, 200);
  assert.equal((await patch(app, '/auth/me', { nickname: 'a'.repeat(21) }, h)).status, 400);

  // emoji：'😀' 的 string.length 是 2，但按 code point 只算 1 个字符。
  // 20 个 emoji（.length === 40）必须通过——若误用 string.length 会 400
  assert.equal((await patch(app, '/auth/me', { nickname: '😀'.repeat(20) }, h)).status, 200);
  assert.equal((await patch(app, '/auth/me', { nickname: '😀'.repeat(21) }, h)).status, 400);
});

test('PATCH /auth/me: nickname 缺失 / 非字符串 / body 非对象 → 400 invalid_nickname', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');
  const h = { authorization: `Bearer ${reg.accessToken}` };
  assert.equal((await patch(app, '/auth/me', {}, h)).status, 400);
  assert.equal((await patch(app, '/auth/me', { nickname: 123 }, h)).status, 400);
  assert.equal((await patch(app, '/auth/me', { nickname: null }, h)).status, 400);
  assert.equal((await patch(app, '/auth/me', ['nickname'], h)).status, 400);
});

test('PATCH /auth/me: 无 Bearer / 坏 token → 401 invalid_token', async () => {
  const { app } = setup();
  await register(app, 'a@example.com');
  assert.equal((await patch(app, '/auth/me', { nickname: 'x' })).status, 401);
  const bad = await patch(app, '/auth/me', { nickname: 'x' }, { authorization: 'Bearer not-a-jwt' });
  assert.equal(bad.status, 401);
  assert.equal(((await bad.json()) as { error: string }).error, 'invalid_token');
});

test('PATCH /auth/me: 注销账号后再改 → 401（账号不再活跃）', async () => {
  const { app } = setup();
  const reg = await register(app, 'gone@example.com');
  const delRes = await app.request('/auth/account', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${reg.accessToken}` },
  });
  assert.equal(delRes.status, 200);
  const res = await patch(app, '/auth/me', { nickname: 'x' }, {
    authorization: `Bearer ${reg.accessToken}`,
  });
  assert.equal(res.status, 401);
});

test('PATCH /auth/me: verify 返回的自动昵称可直接被覆盖', async () => {
  const { app } = setup();
  const reg = await register(app, 'a@example.com');
  assert.match(reg.user.nickname ?? '', /^墨友\d{4}$/);
  const res = await patch(app, '/auth/me', { nickname: '自定义' }, {
    authorization: `Bearer ${reg.accessToken}`,
  });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { user: { nickname?: string } }).user.nickname, '自定义');
});
