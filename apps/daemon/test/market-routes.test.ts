// apps/daemon/test/market-routes.test.ts
// /api/market 镜像与发布编排（设计 §7.1）：发布全链路 + 离线缓存/回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openDatabase } from '../src/core/db.js';
import { marketRoutes } from '../src/routes/market.js';

/** 云端 /market 与 OSS 的 fetch 替身：按 URL 分发 */
function makeCloud(opts: { fail?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const state = { created: 0, confirmed: 0 };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (opts.fail) throw new Error('network down');
    // 注意：confirm 也是 POST /market/listings/:id/confirm，须先于 create 分支判定
    if (u.includes('/confirm')) {
      state.confirmed++;
      return new Response(JSON.stringify({ status: 'active' }), { status: 200 });
    }
    if (u.includes('/market/listings') && init?.method === 'POST') {
      state.created++;
      const id = `01test${state.created}`;
      return new Response(JSON.stringify({
        listingId: id,
        uploads: [
          { key: `next/${id}-vault.zip`, url: `https://oss.local/next/${id}-vault.zip`, contentType: 'application/zip' },
          { key: `next/${id}-p1.png`, url: `https://oss.local/next/${id}-p1.png`, contentType: 'image/png' },
        ],
        expiresAt: Date.now() + 3600_000,
      }), { status: 201 });
    }
    if (u.includes('/market/listings') && (!init || init.method === 'GET') && !u.includes('/my')) {
      return new Response(JSON.stringify({ listings: [{ id: 'x', name: '社区库', priceCents: 0 }] }), { status: 200 });
    }
    if (u.startsWith('https://oss.local/')) { objects.set(u, new Uint8Array((init?.body as Uint8Array) ?? [])); return new Response(null, { status: 200 }); }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, objects, state };
}

function makeVault(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-vault-'));
  fs.writeFileSync(path.join(dir, 'note.md'), '# hi', 'utf8');
  fs.mkdirSync(path.join(dir, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.obsidian', 'c.json'), '{}', 'utf8');
  return dir;
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('publish 编排：打包→创建→直传→确认→本地映射', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const vaultPath = makeVault();
  db.prepare('INSERT INTO vaults (id, name, path, created_at) VALUES (?, ?, ?, ?)').run('v1', '测试库', vaultPath, Date.now());
  const cloud = makeCloud();
  const app = new Hono();
  app.route('/api/market', marketRoutes(db, { getAccessToken: async () => 'tok' } as never, { fetchImpl: cloud.fetchImpl, baseUrl: 'https://cloud.local' }));

  const form = new FormData();
  form.set('vaultId', 'v1');
  form.set('name', '社区库');
  form.set('summary', '简介');
  form.set('icon', '📖');
  form.set('tags', '["读书"]');
  form.append('previews', new File([PNG_1PX], 'p1.png', { type: 'image/png' }));

  const res = await app.request('/api/market/publish', { method: 'POST', body: form });
  assert.equal(res.status, 200);
  assert.equal(cloud.state.created, 1);
  assert.equal(cloud.state.confirmed, 1);
  assert.equal(cloud.objects.size, 2); // zip + 效果图
  const zipKeys = [...cloud.objects.keys()].filter((k) => k.includes('vault.zip'));
  assert.equal(zipKeys.length, 1);
  const localCount = db.prepare('SELECT count(*) AS n FROM market_local').get() as { n: number };
  assert.equal(localCount.n, 1); // 发布成功 → listing→v1 映射落库
});

test('listings：成功落缓存；云端不可达回缓存 stale', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const ok = makeCloud();
  const mk = (fetchImpl: typeof fetch) => {
    const app = new Hono();
    app.route('/api/market', marketRoutes(db, { getAccessToken: async () => 'tok' } as never, { fetchImpl, baseUrl: 'https://cloud.local' }));
    return app;
  };
  const res1 = await mk(ok.fetchImpl).request('/api/market/listings');
  assert.equal(res1.status, 200);
  assert.equal(((await res1.json()) as { stale?: boolean }).stale ?? false, false);
  const res2 = await mk(makeCloud({ fail: true }).fetchImpl).request('/api/market/listings');
  assert.equal(res2.status, 200);
  const body = (await res2.json()) as { stale: boolean; listings: unknown[] };
  assert.equal(body.stale, true);
  assert.equal(body.listings.length, 1); // 来自缓存
});

// ── listings SWR + 超时兜底（2026-09 资源页首开白屏 15s 回归） ──

function mkApp(db: ReturnType<typeof openDatabase>, fetchImpl: typeof fetch, extra: object = {}) {
  const app = new Hono();
  app.route('/api/market', marketRoutes(db, { getAccessToken: async () => 'tok' } as never, { fetchImpl, baseUrl: 'https://cloud.local', ...extra }));
  return app;
}

function seedListingsCache(db: ReturnType<typeof openDatabase>, listings: unknown[], fetchedAt: number): void {
  db.prepare(`INSERT INTO market_cache (key, json, fetched_at) VALUES ('listings', ?, ?)
    ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at`)
    .run(JSON.stringify(listings), fetchedAt);
}

test('listings SWR：有缓存立即返回（stale），过期缓存触发后台刷新落库', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  // fetched_at 足够旧（> 30s 最小刷新间隔）→ 应触发后台刷新
  seedListingsCache(db, [{ id: 'cached', name: '缓存条目', priceCents: 0 }], Date.now() - 120_000);
  const ok = makeCloud();
  const app = mkApp(db, ok.fetchImpl);

  const res = await app.request('/api/market/listings');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { stale: boolean; listings: Array<{ id: string }> };
  assert.equal(body.stale, true);
  assert.equal(body.listings[0]?.id, 'cached'); // 首屏来自缓存，不等云端

  // 后台刷新最终把云端数据写回缓存（轮询等待，上限 2s）
  const deadline = Date.now() + 2_000;
  let refreshed = false;
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT json FROM market_cache WHERE key = 'listings'").get() as { json: string } | undefined;
    if (row && row.json.includes('"id":"x"')) { refreshed = true; break; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(refreshed, '缓存过期后应后台刷新写入云端数据');
});

test('listings SWR：缓存新鲜时不打云端（后台刷新防抖）', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  seedListingsCache(db, [{ id: 'fresh' }], Date.now()); // 刚写入 → age < 30s
  let calls = 0;
  const counting = (async () => {
    calls++;
    return new Response(JSON.stringify({ listings: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const app = mkApp(db, counting);

  const res1 = await app.request('/api/market/listings');
  const res2 = await app.request('/api/market/listings');
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.equal(calls, 0, '缓存新鲜时不应发起云端请求');
});

test('listings 冷启动：云端 hang → 超时后返回空目录 stale，不无限干等', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  // 尊重 abort signal 的「永不响应」mock：AbortSignal.timeout 触发后 reject
  const hang = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
  const app = mkApp(db, hang, { listingsTimeoutMs: 100 });

  const t0 = Date.now();
  const res = await app.request('/api/market/listings');
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(elapsed < 2_000, `应在超时上限附近返回，实际 ${elapsed}ms`);
  const body = (await res.json()) as { stale: boolean; listings: unknown[] };
  assert.deepEqual(body.listings, []);
  assert.equal(body.stale, true);
});

test('写侧成功失效 listings 缓存：下架后目录缓存被清除', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  seedListingsCache(db, [{ id: 'old' }], Date.now());
  const ok = makeCloud();
  const app = mkApp(db, ok.fetchImpl);

  const res = await app.request('/api/market/listings/old', { method: 'DELETE' });
  assert.equal(res.status, 200);
  const row = db.prepare("SELECT json FROM market_cache WHERE key = 'listings'").get();
  assert.equal(row, undefined, '写侧成功后应失效缓存，下次目录页走云端拿最新');
});

test('purchases：带 Bearer 透传云端；云端 502 pay_unreachable 原样归一；断网 502 cloud_unreachable', async () => {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const mk = (fetchImpl: typeof fetch) => {
    const app = new Hono();
    app.route('/api/market', marketRoutes(db, { getAccessToken: async () => 'tok' } as never, { fetchImpl, baseUrl: 'https://cloud.local' }));
    return app;
  };

  // 成功：Authorization 头透传 + 响应原样
  let sawAuth = '';
  const okFetch = (async (url: string, init?: RequestInit) => {
    assert.ok(String(url).endsWith('/market/purchases'));
    sawAuth = String((init?.headers as Record<string, string>)?.['authorization'] ?? '');
    return new Response(JSON.stringify({ purchases: [{ id: 'l1', purchasedAt: '2026-09-01T00:00:00.000Z', listing: null, available: false }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const res = await mk(okFetch).request('/api/market/purchases');
  assert.equal(res.status, 200);
  assert.equal(sawAuth, 'Bearer tok');
  assert.equal(((await res.json()) as { purchases: unknown[] }).purchases.length, 1);

  // 云端 502（pay_unreachable）→ 非白名单状态 → 502 + code 透传
  const pay502 = (async () => new Response(JSON.stringify({ error: 'pay_unreachable' }), { status: 502 })) as unknown as typeof fetch;
  const res2 = await mk(pay502).request('/api/market/purchases');
  assert.equal(res2.status, 502);
  assert.equal(((await res2.json()) as { error: string }).error, 'pay_unreachable');

  // 断网 → 502 cloud_unreachable
  const res3 = await mk(makeCloud({ fail: true }).fetchImpl).request('/api/market/purchases');
  assert.equal(res3.status, 502);
  assert.equal(((await res3.json()) as { error: string }).error, 'cloud_unreachable');
});
