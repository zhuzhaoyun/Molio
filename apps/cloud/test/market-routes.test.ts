// apps/cloud/test/market-routes.test.ts
// 走 createApp().fetch 全链路（内存 store + signer 替身）。按 test/helpers.ts 现有
// 可编程 mock（时钟/store/邮件）装配；登录取 token 走 /auth/send-code + /auth/verify（devCode）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
