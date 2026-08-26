// apps/cloud/test/market-service.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MarketService, MarketServiceError } from '../src/market/service.js';
import { MemoryMarketStore } from '../src/store/market-memory.js';
import { MemoryAuthStore } from '../src/store/memory.js';
import { OssSigner } from '../src/market/signer.js';

const OSS = { bucket: 'molio-pay', region: 'cn-guangzhou', accessKeyId: 'ak', accessKeySecret: 'sk' };

/** 可编程 OSS 替身：对象表 + 复制记录 */
function mockOss() {
  const objects = new Map<string, number>();
  const copied: Array<[string, string, string?]> = [];
  const real = new OssSigner(OSS, { now: () => 1_700_000_000_000 });
  const stub = {
    signPut: real.signPut.bind(real),
    signGet: real.signGet.bind(real),
    baseUrl: real.baseUrl.bind(real),
    headObject: async (key: string) => (objects.has(key) ? { size: objects.get(key)! } : null),
    copyObject: async (src: string, dest: string, acl?: 'private' | 'public-read') => {
      copied.push([src, dest, acl]);
      objects.set(dest, objects.get(src) ?? 0);
    },
    deleteObject: async () => {},
  };
  return { stub, objects, copied };
}

function makeService(over: { admins?: string[]; maxZipMb?: number } = {}) {
  const users = new MemoryAuthStore();
  const store = new MemoryMarketStore();
  const { stub, objects, copied } = mockOss();
  const config = { market: { maxZipMb: over.maxZipMb ?? 50, adminEmails: over.admins ?? [], maxActivePerUser: 10, maxDailyCreates: 5 } };
  const svc = new MarketService({ store, users, signer: stub as never, config: config as never, now: () => 1_700_000_000_000 });
  return { svc, users, store, objects, copied };
}

const VALID = { name: '我的库', summary: '简介', icon: '📖', tags: ['读书', '自定义标签'], vaultSize: 1000, previews: [{ ext: '.png', size: 10 }] };

test('create：凭证第一个恒为 zip；tint 缺省轮转', async () => {
  const { svc, users } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: '墨友0001', now: 1 });
  const res = await svc.create(u.id, VALID);
  assert.match(res.uploads[0]!.key, /^next\/.+vault\.zip$/);
  assert.equal(res.uploads.length, 2);
  assert.equal(res.uploads[1]!.contentType, 'image/png');
});

test('create：元数据非法（超长名/缺效果图/效果图超 5MB/zip 超上限）→ 400', async () => {
  const { svc, users } = makeService({ maxZipMb: 50 });
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const cases = [
    { ...VALID, name: 'x'.repeat(31) },
    { ...VALID, previews: [] },
    { ...VALID, previews: [{ ext: '.png', size: 6 * 1024 * 1024 }] },
    { ...VALID, vaultSize: 51 * 1024 * 1024 },
    { ...VALID, icon: '🚀' }, // 不在预设集
    { ...VALID, tags: ['x'.repeat(11)] }, // 单标签超 10 字
  ];
  for (const c of cases) {
    await assert.rejects(svc.create(u.id, c), (e: unknown) => (e as MarketServiceError).code === 'invalid_metadata');
  }
});

test('confirm：暂存齐全 → active + 效果图转正公共读 + 署名为昵称', async () => {
  const { svc, users, objects, copied } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: '墨友0001', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 100);
  objects.set(c.uploads[1]!.key, 10);
  const my = await svc.confirm(u.id, c.listingId);
  assert.equal(my.status, 'active');
  assert.equal(my.fileSize, 100);
  // 预览图转正到 images/、不设对象 ACL（公开靠桶 Policy 对 images/* 前缀授权，非对象 ACL）
  assert.equal(copied.some(([, d, acl]) => d.startsWith('images/') && d.endsWith('-p1.png') && acl === undefined), true);
  const pub = await svc.list();
  assert.equal(pub[0]!.author, '墨友0001');
  assert.equal(pub[0]!.priceCents, 0);
  assert.deepEqual(pub[0]!.tags, ['读书', '自定义标签']); // 自定义标签原样保留
  assert.match(pub[0]!.previews[0]!, /^https:\/\/molio-pay\.oss-cn-guangzhou\.aliyuncs\.com\/images\/.+p1\.png$/);
});

test('confirm：缺对象 409；zip 超上限 413', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  await assert.rejects(svc.confirm(u.id, c.listingId), (e: unknown) => (e as MarketServiceError).code === 'upload_incomplete');
  objects.set(c.uploads[0]!.key, 51 * 1024 * 1024);
  objects.set(c.uploads[1]!.key, 10);
  await assert.rejects(svc.confirm(u.id, c.listingId), (e: unknown) => (e as MarketServiceError).code === 'size_exceeded');
});

test('限频：日建 5 次封顶；管理员豁免', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  for (let i = 0; i < 5; i++) {
    const c = await svc.create(u.id, { ...VALID, name: `n${i}` });
    objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
    await svc.confirm(u.id, c.listingId);
  }
  await assert.rejects(svc.create(u.id, VALID), (e: unknown) => (e as MarketServiceError).code === 'rate_limited');
  const admin = await users.createActiveUser({ id: 'u2', email: 'admin@x.com', nickname: '管理', now: 1 });
  assert.ok((await svc.create(admin.id, VALID)).listingId);
});

test('归属：非 owner confirm/remove → 403', async () => {
  const { svc, users } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const o = await users.createActiveUser({ id: 'u9', email: 'b@x.com', nickname: 'b', now: 1 });
  const c = await svc.create(u.id, VALID);
  await assert.rejects(svc.confirm(o.id, c.listingId), (e: unknown) => (e as MarketServiceError).code === 'not_owner');
  await assert.rejects(svc.remove(o.id, c.listingId), (e: unknown) => (e as MarketServiceError).code === 'not_owner');
});

test('download：active 可签且带 filename；未上架 404', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 9); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  const dl = await svc.download(u.id, c.listingId);
  assert.match(dl.url, /response-content-disposition=/);
  await assert.rejects(svc.download(u.id, 'nope'), (e: unknown) => (e as MarketServiceError).code === 'listing_not_found');
});

test('下架软删 → 列表不可见；管理员恢复', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const admin = await users.createActiveUser({ id: 'u2', email: 'admin@x.com', nickname: '管理', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  await svc.remove(u.id, c.listingId);
  assert.equal((await svc.list()).length, 0);
  await svc.restore(admin.email, c.listingId);
  assert.equal((await svc.list()).length, 1);
});

test('adminList：全状态视图（内存 store ownerEmail=null）+ 非管理员 403', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const admin = await users.createActiveUser({ id: 'u2', email: 'admin@x.com', nickname: '管理', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  const rows = await svc.adminList(admin.email);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.listing.status, 'active');
  assert.equal(rows[0]!.ownerEmail, null); // 内存 store 语义（Pg 版为真实邮箱）
  await assert.rejects(svc.adminList(u.email), (e: unknown) => (e as MarketServiceError).code === 'not_owner');
});

test('更新版本：zip 覆盖 + v1.1 + 效果图整组替换', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  const up = await svc.update(u.id, c.listingId, { previews: [{ ext: '.jpg', size: 2 }] });
  objects.set(up.uploads[0]!.key, 2); objects.set(up.uploads[1]!.key, 2);
  const after = await svc.confirm(u.id, c.listingId);
  assert.equal(after.version, 'v1.1');
  assert.equal(after.previews.length, 1);
  assert.match(after.previews[0]!, /-p1\.jpg$/);
});

test('定价(§六)：管理员可设价，非管理员传值强制 0；付费下载 402 门禁', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  // 管理员：priceCents>0 + payUrl 落库
  const admin = await users.createActiveUser({ id: 'a1', email: 'admin@x.com', nickname: '管', now: 1 });
  const ac = await svc.create(admin.id, { ...VALID, name: '付费库', priceCents: 1990, payUrl: 'https://pay.example.com/x' });
  objects.set(ac.uploads[0]!.key, 1); objects.set(ac.uploads[1]!.key, 1);
  const amy = await svc.confirm(admin.id, ac.listingId);
  assert.equal(amy.priceCents, 1990);
  assert.equal(amy.payUrl, 'https://pay.example.com/x');
  // 付费未购买 → 402 payment_required（不外发免费签名下载，Model A 走 payUrl 外链）
  await assert.rejects(
    svc.download(admin.id, ac.listingId),
    (e: unknown) => (e as MarketServiceError).code === 'payment_required' && (e as MarketServiceError).status === 402,
  );
  // 非管理员：priceCents>0 被服务端强制 0、payUrl 忽略
  const u = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, { ...VALID, name: '免费库', priceCents: 5000, payUrl: 'https://pay.example.com/y' });
  objects.set(c.uploads[0]!.key, 9); objects.set(c.uploads[1]!.key, 1);
  const my = await svc.confirm(u.id, c.listingId);
  assert.equal(my.priceCents, 0);
  assert.equal(my.payUrl, '');
  // 免费可正常签下载
  const dl = await svc.download(u.id, c.listingId);
  assert.match(dl.url, /response-content-disposition=/);
});

test('更新版本调价：管理员可改，非管理员传值被忽略', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  const admin = await users.createActiveUser({ id: 'a1', email: 'admin@x.com', nickname: '管', now: 1 });
  const c = await svc.create(admin.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(admin.id, c.listingId);
  // 管理员调价：9900 分 + 外链
  const up = await svc.update(admin.id, c.listingId, { previews: [], priceCents: 9900, payUrl: 'https://pay.example.com/z' });
  objects.set(up.uploads[0]!.key, 2);
  await svc.confirm(admin.id, c.listingId);
  assert.equal((await svc.get(c.listingId)).priceCents, 9900);
  // 非管理员 owner：调价被忽略（保持 0）
  const u = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: 'n', now: 1 });
  const c2 = await svc.create(u.id, VALID);
  objects.set(c2.uploads[0]!.key, 1); objects.set(c2.uploads[1]!.key, 1);
  await svc.confirm(u.id, c2.listingId);
  await svc.update(u.id, c2.listingId, { priceCents: 5000, payUrl: 'https://x.com' });
  assert.equal((await svc.get(c2.listingId)).priceCents, 0);
});
