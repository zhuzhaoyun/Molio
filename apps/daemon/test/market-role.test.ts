// apps/daemon/test/market-role.test.ts
// GET /api/market/role —— 「发布到资源库」身份门禁的本地缓存。
// 用户报告（2026-10）：管理员点「发布到资源库」被丢进系统浏览器（联系页），
// 进不了页内发布配置页。根因是门禁当时只认 /api/market/my 的云端往返（1~4s）：
// 未落定的窗口里点击就按非管理员处理。这里锁住「本地即答 + 未决不等于非管理员」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDatabase } from '../src/core/db.js';
import { marketRoutes } from '../src/routes/market.js';

interface CloudState { myCalls: number; fail: boolean; isAdmin: boolean }

/** 云端 /market/my 替身：记录调用次数，可切换「管理员 / 非管理员 / 断网」 */
function makeCloud(over: { isAdmin?: boolean; fail?: boolean } = {}) {
  const state: CloudState = { myCalls: 0, fail: over.fail === true, isAdmin: over.isAdmin === true };
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.endsWith('/market/my')) {
      state.myCalls++;
      if (state.fail) throw new Error('network down');
      return new Response(JSON.stringify({ isAdmin: state.isAdmin, listings: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, state };
}

function makeDb(): ReturnType<typeof openDatabase> {
  return openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-role-db-')));
}

function makeApp(
  db: ReturnType<typeof openDatabase>,
  cloud: ReturnType<typeof makeCloud>,
  userId: string | null,
  roleTtlMs?: number,
) {
  const app = new Hono();
  app.route('/api/market', marketRoutes(
    db,
    {
      getAccessToken: async () => 'tok',
      getStatus: async () => (userId
        ? { loggedIn: true, configured: true, user: { id: userId, email: `${userId}@x.com`, createdAt: '2026-01-01' } }
        : { loggedIn: false, configured: true }),
    } as never,
    { fetchImpl: cloud.fetchImpl, baseUrl: 'https://cloud.local', ...(roleTtlMs !== undefined ? { roleTtlMs } : {}) },
  ));
  return app;
}

const roleOf = async (app: Hono): Promise<{ loggedIn: boolean; isAdmin: boolean | null }> => {
  const res = await app.request('/api/market/role');
  assert.equal(res.status, 200);
  return (await res.json()) as { loggedIn: boolean; isAdmin: boolean | null };
};

test('/role：冷缓存走一次云端，之后本地即答', async () => {
  const db = makeDb();
  const cloud = makeCloud({ isAdmin: true });
  const app = makeApp(db, cloud, 'u1');

  assert.deepEqual(await roleOf(app), { loggedIn: true, isAdmin: true });
  assert.equal(cloud.state.myCalls, 1);

  // 第二次点击（KB 页重进 / 组件重挂载）不再打云端
  assert.deepEqual(await roleOf(app), { loggedIn: true, isAdmin: true });
  assert.equal(cloud.state.myCalls, 1);
});

test('/role：daemon 重启（新 app、同库）+ 断网仍是 admin —— 缓存落盘', async () => {
  const db = makeDb();
  const online = makeCloud({ isAdmin: true });
  const boot1 = makeApp(db, online, 'u1');
  assert.deepEqual(await roleOf(boot1), { loggedIn: true, isAdmin: true });

  const offline = makeCloud({ fail: true });
  const boot2 = makeApp(db, offline, 'u1');
  assert.deepEqual(await roleOf(boot2), { loggedIn: true, isAdmin: true });
  assert.equal(offline.state.myCalls, 0); // 直接吃缓存，不等云端
});

test('/role：判定失败无缓存 → isAdmin=null（未决），不是 false', async () => {
  const db = makeDb();
  const cloud = makeCloud({ fail: true });
  const app = makeApp(db, cloud, 'u1');

  // 关键：null 让前端保持 pending。若回 false，管理员会被当成非管理员踢去浏览器。
  assert.deepEqual(await roleOf(app), { loggedIn: true, isAdmin: null });
  assert.equal(cloud.state.myCalls, 1);
});

test('/role：换账号不复用别人的管理员缓存', async () => {
  const db = makeDb();
  const cloud = makeCloud({ isAdmin: true });
  assert.deepEqual(await roleOf(makeApp(db, cloud, 'u1')), { loggedIn: true, isAdmin: true });

  cloud.state.isAdmin = false;
  assert.deepEqual(await roleOf(makeApp(db, cloud, 'u2')), { loggedIn: true, isAdmin: false });
  assert.equal(cloud.state.myCalls, 2);
});

test('/role：未登录不打云端', async () => {
  const db = makeDb();
  const cloud = makeCloud({ isAdmin: true });
  assert.deepEqual(await roleOf(makeApp(db, cloud, null)), { loggedIn: false, isAdmin: null });
  assert.equal(cloud.state.myCalls, 0);
});

test('/role：过期缓存先回旧值，后台刷新跟上撤权', async () => {
  const db = makeDb();
  const cloud = makeCloud({ isAdmin: true });
  const app = makeApp(db, cloud, 'u1', 0); // TTL=0：每次请求都视为过期
  assert.deepEqual(await roleOf(app), { loggedIn: true, isAdmin: true });

  // 云端撤权：本次仍回缓存里的 true（UI 不等云端），后台刷新后在下次请求反映
  cloud.state.isAdmin = false;
  assert.deepEqual(await roleOf(app), { loggedIn: true, isAdmin: true });

  let role: { loggedIn: boolean; isAdmin: boolean | null } | null = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    role = await roleOf(app);
    if (role.isAdmin === false) break;
  }
  assert.equal(role?.isAdmin, false);
});
