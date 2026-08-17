import assert from 'node:assert/strict';
import test from 'node:test';
import { post, register, setup } from './helpers.js';

test('verify: 全链路——隐式注册并返回 token 对 + 用户', async () => {
  const { app } = setup();
  const reg = await register(app, 'new@example.com');
  assert.ok(reg.accessToken.length > 0);
  assert.ok(reg.refreshToken.length > 0);
  assert.ok(reg.user.id.length === 26); // ULID
  assert.equal(reg.user.email, 'new@example.com');
  // 隐式注册自动生成昵称：「墨友」+ 4 位数字
  assert.match(reg.user.nickname ?? '', /^墨友\d{4}$/, '新注册用户应带自动昵称');
});

test('verify: 自动昵称每次注册独立随机（允许重名，不做唯一约束）', async () => {
  const { app } = setup();
  const a = await register(app, 'a@example.com');
  const b = await register(app, 'b@example.com');
  assert.match(a.user.nickname ?? '', /^墨友\d{4}$/);
  assert.match(b.user.nickname ?? '', /^墨友\d{4}$/);
});

test('verify: 邮箱大小写归一化——混合大小写发码、小写验证', async () => {
  const { app } = setup();
  const r1 = await post(app, '/auth/send-code', { email: 'Foo@Example.com' });
  const { devCode } = (await r1.json()) as { devCode: string };
  const r2 = await post(app, '/auth/verify', { email: 'foo@example.com', code: devCode });
  assert.equal(r2.status, 200);
  const body = (await r2.json()) as { user: { email: string } };
  assert.equal(body.user.email, 'foo@example.com');
});

test('verify: 错码 → 401 invalid_code；错满 5 次 → locked（对码也不放行）', async () => {
  const { app } = setup();
  const r1 = await post(app, '/auth/send-code', { email: 'a@example.com' });
  const { devCode } = (await r1.json()) as { devCode: string };
  const wrong = devCode === '000000' ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    const r = await post(app, '/auth/verify', { email: 'a@example.com', code: wrong });
    assert.equal(r.status, 401);
    assert.equal(((await r.json()) as { error: string }).error, 'invalid_code');
  }
  // 第 6 次即使码正确也已锁定
  const r = await post(app, '/auth/verify', { email: 'a@example.com', code: devCode });
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as { error: string }).error, 'locked');
});

test('verify: 验证码 5 分钟过期 → invalid_code', async () => {
  const { app, clock } = setup();
  const r1 = await post(app, '/auth/send-code', { email: 'a@example.com' });
  const { devCode } = (await r1.json()) as { devCode: string };
  clock.advance(301_000);
  const r = await post(app, '/auth/verify', { email: 'a@example.com', code: devCode });
  assert.equal(r.status, 401);
  assert.equal(((await r.json()) as { error: string }).error, 'invalid_code');
});

test('verify: 验证码一次性——验证成功后同码不能再用', async () => {
  const { app } = setup();
  const r1 = await post(app, '/auth/send-code', { email: 'a@example.com' });
  const { devCode } = (await r1.json()) as { devCode: string };
  assert.equal((await post(app, '/auth/verify', { email: 'a@example.com', code: devCode })).status, 200);
  const r = await post(app, '/auth/verify', { email: 'a@example.com', code: devCode });
  assert.equal(r.status, 401);
});

test('verify: 同邮箱二次登录复用同一用户（注册=登录幂等）', async () => {
  const { app, clock } = setup();
  const first = await register(app, 'a@example.com');
  clock.advance(61_000); // 越过重发间隔
  const second = await register(app, 'a@example.com');
  assert.equal(second.user.id, first.user.id);
});

test('verify: 并发注册兜底——unique_violation 后回退复用已有账号', async () => {
  const { service, store, clock } = setup();
  // 模拟"另一个请求已建号"
  await store.createActiveUser({ id: 'pre-user', email: 'race@example.com', nickname: '墨友9999', now: clock.now() });
  // 让第一次 findActiveUserByEmail 返回 null，逼 verify 走注册分支撞唯一约束
  const orig = store.findActiveUserByEmail.bind(store);
  let calls = 0;
  store.findActiveUserByEmail = async (email: string) => {
    calls += 1;
    return calls === 1 ? null : orig(email);
  };

  const { devCode } = await service.sendCode('race@example.com', null);
  assert.ok(devCode, 'daily 模式应返回 devCode');
  const res = await service.verify('race@example.com', devCode!);
  assert.equal(res.user.id, 'pre-user');
});

test('verify: 注销账号后同邮箱再注册 → 新账号（新 userId，§二拍板）', async () => {
  const { app, clock } = setup();
  const reg = await register(app, 'gone@example.com');

  const delRes = await app.request('/auth/account', {
    method: 'DELETE',
    headers: { authorization: `Bearer ${reg.accessToken}` },
  });
  assert.equal(delRes.status, 200);

  clock.advance(61_000);
  const again = await register(app, 'gone@example.com');
  assert.notEqual(again.user.id, reg.user.id);
});
