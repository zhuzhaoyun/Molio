import assert from 'node:assert/strict';
import test from 'node:test';
import { hashRefreshToken } from '../src/crypto.js';
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

test('refresh: 原子吊销竞态输家 → 重读最新状态走宽限窗重放路径（不误判攻击）', async () => {
  const { app, store, clock, config } = setup();
  const reg = await register(app);
  const rec = await store.findRefreshTokenByHash(hashRefreshToken(reg.refreshToken));
  assert.ok(rec);

  // 模拟另一实例先完成轮换：本次 revoke 到达时旧 token 已被吊销并发出新对，
  // 条件吊销返回 false（竞态输家）
  const realRevoke = store.revokeRefreshToken.bind(store);
  let raced = false;
  store.revokeRefreshToken = async (id, now, replacedBy) => {
    if (!raced && id === rec!.id) {
      raced = true;
      await realRevoke(id, now, 'winner-tok');
      await store.insertRefreshToken({
        id: 'winner-tok',
        userId: rec!.userId,
        tokenHash: hashRefreshToken('winner-raw-token'),
        deviceHint: null,
        createdAt: now,
        expiresAt: now + config.refreshTtlSec * 1000,
        revokedAt: null,
        replacedBy: null,
      });
      return false;
    }
    return realRevoke(id, now, replacedBy);
  };

  // 输家不抛错也不全吊销：沿替换链找到链头并轮换，客户端拿到可用的新对
  clock.advance(1_000); // 仍在 30s 宽限窗内
  const res = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { refreshToken: string };

  const next = await post(app, '/auth/refresh', { refreshToken: body.refreshToken });
  assert.equal(next.status, 200);
});

test('refresh: 宽限窗内但链头也已失效 → 按攻击处理，全吊销', async () => {
  const { app, clock } = setup();
  const reg = await register(app);

  const r1 = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  const r2 = (await r1.json()) as { refreshToken: string };
  // 链头 R2 被人工登出（replaced_by 链断在已吊销节点）
  const out = await del(app, '/auth/session', { refreshToken: r2.refreshToken }, {
    authorization: `Bearer ${reg.accessToken}`,
  });
  assert.equal(out.status, 200);

  // 窗内重放 R1：链头不可用 → 不再宽松，全吊销
  const replay = await post(app, '/auth/refresh', { refreshToken: reg.refreshToken });
  assert.equal(replay.status, 401);
});
