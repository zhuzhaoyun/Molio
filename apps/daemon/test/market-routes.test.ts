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
