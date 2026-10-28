// apps/cloud/test/market-routes.test.ts
// 走 createApp().fetch 全链路（内存 store + signer 替身）。按 test/helpers.ts 现有
// 可编程 mock（时钟/store/邮件）装配；登录取 token 走 /auth/send-code + /auth/verify（devCode）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { MarketService } from '../src/market/service.js';
import { OssSigner } from '../src/market/signer.js';
import { AuthService } from '../src/service.js';
import { MemoryAuthStore } from '../src/store/memory.js';
import { MemoryMarketStore } from '../src/store/market-memory.js';
import { makeClock, register, testConfig } from './helpers.js';

// config.market 形状（设计 §六）：oss + 限频/管理员配置
const MARKET_CFG = {
  oss: { accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'molio-pay', region: 'cn-guangzhou', endpointOverride: 'https://mock' },
  maxZipMb: 50,
  adminEmails: ['admin@x.com'],
  maxActivePerUser: 10,
  maxDailyCreates: 5,
};

// bootMarketApp：helpers 模式封装——MemoryAuthStore + MemoryMarketStore + signer 替身
// （headObject→{size:10}, copyObject/deleteObject no-op, baseUrl→https://mock）；
// token 通过 send-code（取 devCode）+ verify 获得。
async function bootMarketApp() {
  const clock = makeClock();
  const authStore = new MemoryAuthStore();
  const marketStore = new MemoryMarketStore();
  const config = testConfig({ market: MARKET_CFG });
  const authService = new AuthService({ store: authStore, config, sendMail: async () => {}, now: clock.now });

  // signer 替身：签名/URL 用真 OssSigner（endpointOverride → baseUrl=https://mock），
  // 对象操作全 stub（与 market-service.test.ts mockOss 同款思路）
  const real = new OssSigner(MARKET_CFG.oss, { now: clock.now });
  const signer = {
    signPut: real.signPut.bind(real),
    signGet: real.signGet.bind(real),
    baseUrl: real.baseUrl.bind(real),
    headObject: async () => ({ size: 10 }),
    copyObject: async () => {},
    deleteObject: async () => {},
  };
  const marketService = new MarketService({
    store: marketStore, users: authStore, signer: signer as never, config: { market: MARKET_CFG }, now: clock.now,
  });

  const app = createApp({ service: authService, config, storeKind: 'memory', now: clock.now, market: { service: marketService } });
  // market 未配置（无 OSS 凭证）→ /market 不挂载
  const appNoMarket = createApp({ service: authService, config: testConfig(), storeKind: 'memory', now: clock.now });

  const reg = await register(app);
  return { app, appNoMarket, token: reg.accessToken, clock, marketStore };
}

test('GET /market/listings：公开 200 + Cache-Control: no-store', async () => {
  const { app } = await bootMarketApp();
  const res = await app.request('/market/listings');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(((await res.json()) as { listings: unknown[] }).listings, []);
});

test('POST /market/listings：未登录 401；登录后 201 带凭证', async () => {
  const { app, token } = await bootMarketApp();
  const res401 = await app.request('/market/listings', { method: 'POST' });
  assert.equal(res401.status, 401);
  const res = await app.request('/market/listings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'n', summary: 's', icon: '📖', tags: [], vaultSize: 10, previews: [{ ext: '.png', size: 5 }] }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { listingId: string; uploads: unknown[] };
  assert.ok(body.listingId);
  assert.equal(body.uploads.length, 2);
});

test('GET /market/listings/:id/download：未登录 401', async () => {
  const { app } = await bootMarketApp();
  assert.equal((await app.request('/market/listings/x/download')).status, 401);
});

test('market 未配置（无 OSS 凭证）→ 404（路由未挂载）', async () => {
  const { appNoMarket } = await bootMarketApp();
  assert.equal((await appNoMarket.request('/market/listings')).status, 404);
});

test('GET /market/purchases：未登录 401；登录 200 + no-store（pay 未配置 → 空列表）', async () => {
  const { app, token } = await bootMarketApp();
  assert.equal((await app.request('/market/purchases')).status, 401);
  const res = await app.request('/market/purchases', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await res.json()) as { purchases: unknown[] }, { purchases: [] });
});


test('taxonomy routes: public registry, protected creation, duplicate reuse and kind validation', async () => {
  const {app,token}=await bootMarketApp();
  const send=(bearer:string,body:unknown)=>app.request('/market/taxonomy',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bearer},body:JSON.stringify(body)});
  const reg=await (await app.request('/market/taxonomy')).json() as {categories:unknown[]};
  assert.equal(reg.categories.length,6);
  assert.equal((await send('',{kind:'category',name:'数学'})).status,401);
  assert.equal((await send(token,{kind:'category',name:'数学'})).status,403);
  const admin=await register(app,'admin@x.com');
  const first=await send(admin.accessToken,{kind:'category',name:' 数学 '});
  assert.equal(first.status,201);
  const a=await first.json() as {id:string};
  const b=await (await send(admin.accessToken,{kind:'category',name:'数学'})).json() as {id:string};
  assert.equal(a.id,b.id);
  assert.equal((await send(admin.accessToken,{kind:'invalid',name:'数学'})).status,400);
});

test('POST /market/admin/listings/:id/content：管理员写入结构化内容，非管理员 403，非法内容 400', async () => {
  const { app, token, marketStore } = await bootMarketApp();
  const id = '01JABCDE0000000000000009';
  await marketStore.insertListing({
    id, userId: 'u1', source: 'community', name: '数学', icon: '📖', tint: '#eee',
    summary: 's', overview: [], highlights: [], content: null, tags: [], previews: [],
    version: 'v1.0', priceCents: 0, payUrl: '', authorDisplay: 'a',
    ossKey: 'zips/x.zip', fileSize: 1, status: 'active', removedReason: null,
    createdAt: 1, updatedAt: 1, publishedAt: 1,
  });
  const content = {
    version: 1,
    positioning: { what: '一份测试知识库', who: ['测试者'], notFor: ['不是题库'] },
    facts: [{ label: '概念页', value: '10 个' }],
    themes: [{ name: '主题', summary: '范围', items: ['条目'] }],
    questions: [{ question: '问题？', answer: '答案。', source: '《测试》' }],
    delivery: { format: 'Markdown', includes: ['内容'], requirements: [], steps: ['打开'] },
    review: { basis: '测试', reviewedAt: '2026-10-26', status: 'draft' },
  };
  const send = (bearer: string, body: unknown) => app.request(`/market/admin/listings/${id}/content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  assert.equal((await send(token, { content })).status, 403, '普通用户不能写内容');
  const admin = await register(app, 'admin@x.com');
  const ok = await send(admin.accessToken, { content });
  assert.equal(ok.status, 200);
  const row = await ok.json() as { content?: { version: number; facts: unknown[] } };
  assert.equal(row.content?.version, 1);
  assert.equal(row.content?.facts.length, 1);
  assert.equal((await send(admin.accessToken, { content: { version: 2 } })).status, 400, '非法内容拒绝');
});

test('admin content: 高中数学样例通过 MarketContent 校验', async () => {
  const { app, marketStore } = await bootMarketApp();
  const id = '01M4PZPNGWR1YZ1W9GGVTJG82N';
  await marketStore.insertListing({
    id, userId: 'u1', source: 'community', name: '高中数学', icon: '📖', tint: '#eee',
    summary: 's', overview: [], highlights: [], content: null, tags: [], previews: [],
    version: 'v1.0', priceCents: 9850, payUrl: '', authorDisplay: 'a',
    ossKey: 'zips/x.zip', fileSize: 1, status: 'active', removedReason: null,
    createdAt: 1, updatedAt: 1, publishedAt: 1,
  });
  const content = JSON.parse(readFileSync(
    path.resolve(process.cwd(), '../../content/market/01M4PZPNGWR1YZ1W9GGVTJG82N.json'),
    'utf8',
  ));
  const admin = await register(app, 'admin@x.com');
  const res = await app.request(`/market/admin/listings/${id}/content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.accessToken}` },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200);
  const row = await res.json() as { content?: { facts: unknown[]; themes: unknown[]; questions: unknown[] } };
  assert.equal(row.content?.facts.length, 6);
  assert.equal(row.content?.themes.length, 8);
  assert.equal(row.content?.questions.length, 4);
});
