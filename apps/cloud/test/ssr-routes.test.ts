// apps/cloud/test/ssr-routes.test.ts
// 官网商品页 SSR（/resource/{id}.html + /sitemap-products.xml）全链路：
// createApp().fetch + 内存 store。覆盖 SEO 要素、XSS 转义、404 语义、缓存头、
// 相关商品互链与 sitemap 内容 —— 这些是收录效果的核心契约，回归必须挡住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { MarketService } from '../src/market/service.js';
import { OssSigner } from '../src/market/signer.js';
import { AuthService } from '../src/service.js';
import { MemoryAuthStore } from '../src/store/memory.js';
import { MemoryMarketStore } from '../src/store/market-memory.js';
import type { MarketListingRecord } from '../src/store/market-types.js';
import { makeClock, testConfig } from './helpers.js';

const MARKET_CFG = {
  oss: { accessKeyId: 'ak', accessKeySecret: 'sk', bucket: 'molio-pay', region: 'cn-guangzhou', endpointOverride: 'https://mock' },
  maxZipMb: 50,
  adminEmails: ['admin@x.com'],
  maxActivePerUser: 10,
  maxDailyCreates: 5,
};

function listing(over: Partial<MarketListingRecord>): MarketListingRecord {
  return {
    id: '01JABCDE0000000000000001', userId: 'u1', source: 'community',
    name: '红楼梦人物关系图谱', icon: '📖', tint: '#FFE8E8',
    summary: '结构化人物关系，导入即用。\n\n覆盖主要人物与亲属关系。',
    overview: [], highlights: [], tags: ['红楼梦', '知识图谱'],
    previews: ['https://mock/images/p1.png'], version: 'v1.0',
    priceCents: 590, payUrl: '', authorDisplay: '墨友0001',
    ossKey: 'zips/x.zip', fileSize: 2048, status: 'active', removedReason: null,
    createdAt: 1_750_000_000_000, updatedAt: 1_750_000_000_000, publishedAt: 1_750_000_000_000,
    ...over,
  };
}

async function bootSsrApp() {
  const clock = makeClock();
  const authStore = new MemoryAuthStore();
  const marketStore = new MemoryMarketStore();
  const config = testConfig({ market: MARKET_CFG });
  const authService = new AuthService({ store: authStore, config, sendMail: async () => {}, now: clock.now });
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
  const appNoMarket = createApp({ service: authService, config: testConfig(), storeKind: 'memory', now: clock.now });
  return { app, appNoMarket, marketStore };
}

test('SSR 商品页：200 + SEO 要素齐全（title/canonical/OG/Product JSON-LD/正文）', async () => {
  const { app, marketStore } = await bootSsrApp();
  await marketStore.insertListing(listing({}));
  const res = await app.request('/resource/01JABCDE0000000000000001.html');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  const html = await res.text();
  // 爬虫零 JS 可读：正文/价格/元信息直接在 HTML 里
  assert.ok(html.includes('<h1>红楼梦人物关系图谱</h1>'), 'H1 商品名');
  assert.ok(html.includes('¥5.9'), '价格（分→元）');
  assert.ok(html.includes('结构化人物关系，导入即用。'), '摘要正文');
  // SEO 标签
  assert.ok(html.includes('<title>红楼梦人物关系图谱 — 知识图谱下载 | Molio</title>'));
  assert.ok(html.includes('<link rel="canonical" href="https://molio.cn/resource/01JABCDE0000000000000001.html">'));
  assert.ok(html.includes('<meta property="og:type" content="product">'));
  // Product 结构化数据：价格换算 + InStock
  assert.ok(html.includes('"@type":"Product"'));
  assert.ok(html.includes('"price":"5.90"'));
  assert.ok(html.includes('"priceCurrency":"CNY"'));
  assert.ok(html.includes('https://schema.org/InStock'));
  // 面包屑（HTML + BreadcrumbList JSON-LD）
  assert.ok(html.includes('"@type":"BreadcrumbList"'));
  // 内嵌数据供交互层水合
  assert.ok(html.includes('window.__LISTING__'));
});

test('SSR 商品页：用户提交内容做 XSS 转义（HTML 与内嵌 JSON 双通道）', async () => {
  const { app, marketStore } = await bootSsrApp();
  await marketStore.insertListing(listing({ name: '<script>alert(1)</script>', summary: '"><img src=x onerror=alert(1)>' }));
  const html = await (await app.request('/resource/01JABCDE0000000000000001.html')).text();
  assert.ok(!html.includes('<script>alert(1)</script>'), 'HTML 中不得出现未转义脚本');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'HTML 通道转义');
  assert.ok(html.includes('\\u003c'), '内嵌 JSON 通道 < 转义');
  assert.ok(!html.includes('"><img src=x onerror=alert(1)>'), 'summary 注入被转义');
});

test('SSR 商品页：付费形态三选一 CTA', async () => {
  const { app, marketStore } = await bootSsrApp();
  // 微信支付（priceCents>0 且无 payUrl）
  await marketStore.insertListing(listing({}));
  let html = await (await app.request('/resource/01JABCDE0000000000000001.html')).text();
  assert.ok(html.includes('id="pay-btn"'), '微信支付按钮');
  assert.ok(html.includes('data-auth-gate="微信支付 ¥5.9"'), '登录门槛文案承载');
  // 外链购买（有 payUrl）
  await marketStore.insertListing(listing({ id: '01JABCDE0000000000000002', payUrl: 'https://pay.example/x?a=1&b=2' }));
  html = await (await app.request('/resource/01JABCDE0000000000000002.html')).text();
  assert.ok(html.includes('id="payurl-btn"'));
  assert.ok(html.includes('data-url="https://pay.example/x?a=1&amp;b=2"'), 'payUrl 属性转义');
  // 免费（签名下载）
  await marketStore.insertListing(listing({ id: '01JABCDE0000000000000003', priceCents: 0 }));
  html = await (await app.request('/resource/01JABCDE0000000000000003.html')).text();
  assert.ok(html.includes('id="market-dl-btn"'), '免费下载按钮');
  assert.ok(html.includes('>免费</span>'), '免费价格展示');
});

test('SSR 商品页：相关商品互链排除自身、链接指向新格式', async () => {
  const { app, marketStore } = await bootSsrApp();
  await marketStore.insertListing(listing({}));
  await marketStore.insertListing(listing({ id: '01JABCDE0000000000000002', name: '唐诗三百首知识图谱' }));
  const html = await (await app.request('/resource/01JABCDE0000000000000001.html')).text();
  const relatedBlock = html.slice(html.indexOf('相关资源'));
  assert.ok(relatedBlock.includes('/resource/01JABCDE0000000000000002.html'), '互链指向新格式');
  assert.ok(relatedBlock.includes('唐诗三百首知识图谱'));
  assert.ok(!relatedBlock.includes('/resource/01JABCDE0000000000000001.html'), '相关区不含自身');
});

test('SSR 商品页：不存在/非法 id → 真实 404 且不缓存', async () => {
  const { app } = await bootSsrApp();
  // 格式合法但不存在
  const miss = await app.request('/resource/01JZZZZZZZZZZZZZZZZZZZZZZZ.html');
  assert.equal(miss.status, 404);
  assert.equal(miss.headers.get('cache-control'), 'no-store');
  assert.ok((await miss.text()).includes('资源不存在'));
  // 非法字符（正则拦截，不进 service）
  assert.equal((await app.request('/resource/..%2Fevil.html')).status, 404);
  // 缺 .html 后缀
  assert.equal((await app.request('/resource/01JABCDE0000000000000001')).status, 404);
});

test('SSR 商品页：已下架条目 → 404（不泄露下架内容）', async () => {
  const { app, marketStore } = await bootSsrApp();
  await marketStore.insertListing(listing({ status: 'removed' }));
  assert.equal((await app.request('/resource/01JABCDE0000000000000001.html')).status, 404);
});

test('动态 sitemap：全量在售商品 + lastmod，非法/下架条目不出现', async () => {
  const { app, marketStore } = await bootSsrApp();
  await marketStore.insertListing(listing({}));
  await marketStore.insertListing(listing({ id: '01JABCDE0000000000000002' }));
  await marketStore.insertListing(listing({ id: '01JABCDE0000000000000003', status: 'uploading' }));
  const res = await app.request('/sitemap-products.xml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /application\/xml/);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  const xml = await res.text();
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(xml.includes('<loc>https://molio.cn/resource/01JABCDE0000000000000001.html</loc>'));
  assert.ok(xml.includes('<loc>https://molio.cn/resource/01JABCDE0000000000000002.html</loc>'));
  assert.ok(!xml.includes('01JABCDE0000000000000003'), 'uploading 不进 sitemap');
  assert.match(xml, /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
});

test('市场未挂载（无 OSS 凭证）→ SSR 路由同样 404', async () => {
  const { appNoMarket } = await bootSsrApp();
  assert.equal((await appNoMarket.request('/resource/01JABCDE0000000000000001.html')).status, 404);
  assert.equal((await appNoMarket.request('/sitemap-products.xml')).status, 404);
});
