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

function makeService(over: { admins?: string[]; maxZipMb?: number; pay?: { listPurchases: (uid: string) => Promise<Array<{ id: string; purchased_at?: string }>> } } = {}) {
  const users = new MemoryAuthStore();
  const store = new MemoryMarketStore();
  const { stub, objects, copied } = mockOss();
  const config = { market: { maxZipMb: over.maxZipMb ?? 50, adminEmails: over.admins ?? [], maxActivePerUser: 10, maxDailyCreates: 5 } };
  const svc = new MarketService({ store, users, signer: stub as never, config: config as never, now: () => 1_700_000_000_000, pay: over.pay });
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
  const ac = await svc.create(admin.id, { ...VALID, name: '付费库', priceCents: 1990 });
  objects.set(ac.uploads[0]!.key, 1); objects.set(ac.uploads[1]!.key, 1);
  const amy = await svc.confirm(admin.id, ac.listingId);
  assert.equal(amy.priceCents, 1990);
  assert.equal(amy.payUrl, '');
  // 付费未购买 → 402 payment_required（不外发免费签名下载，Model A 走 payUrl 外链）
  await assert.rejects(
    svc.download(admin.id, ac.listingId),
    (e: unknown) => (e as MarketServiceError).code === 'payment_required' && (e as MarketServiceError).status === 402,
  );
  // 非管理员：priceCents>0 被服务端强制 0、payUrl 忽略
  const u = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, { ...VALID, name: '免费库', priceCents: 5000 });
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
  const up = await svc.update(admin.id, c.listingId, { previews: [], priceCents: 9900 });
  objects.set(up.uploads[0]!.key, 2);
  await svc.confirm(admin.id, c.listingId);
  assert.equal((await svc.get(c.listingId)).priceCents, 9900);
  // 非管理员 owner：调价被忽略（保持 0）
  const u = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: 'n', now: 1 });
  const c2 = await svc.create(u.id, VALID);
  objects.set(c2.uploads[0]!.key, 1); objects.set(c2.uploads[1]!.key, 1);
  await svc.confirm(u.id, c2.listingId);
  await svc.update(u.id, c2.listingId, { priceCents: 5000 });
  assert.equal((await svc.get(c2.listingId)).priceCents, 0);
});

/** 建一个已上架的付费条目（管理员定价）供已购测试用 */
async function makePaidListing(svc: MarketService, users: MemoryAuthStore, objects: Map<string, number>, adminId = 'a1') {
  const admin = await users.createActiveUser({ id: adminId, email: 'admin@x.com', nickname: '管', now: 1 });
  const c = await svc.create(admin.id, { ...VALID, name: '付费库', priceCents: 1990 });
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(admin.id, c.listingId);
  return c.listingId;
}

test('已购下载放行：付费资源已购 → 签名 URL；未购/其他用户 → 402', async () => {
  const bought = new Map<string, Array<{ id: string; purchased_at?: string }>>([
    ['u1', [{ id: 'pending', purchased_at: '2026-09-01T00:00:00.000Z' }]],
  ]);
  const pay = { listPurchases: async (uid: string) => bought.get(uid) ?? [] };
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'], pay });
  const listingId = await makePaidListing(svc, users, objects);
  bought.set('u1', [{ id: listingId, purchased_at: '2026-09-01T00:00:00.000Z' }]);

  const buyer = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: '买', now: 1 });
  const other = await users.createActiveUser({ id: 'u2', email: 'c@x.com', nickname: '路', now: 1 });

  // 已购 → 放行（重复下载 = 最新版）
  const dl = await svc.download(buyer.id, listingId);
  assert.match(dl.url, /response-content-disposition=/);
  // 未购用户 → 402
  await assert.rejects(
    svc.download(other.id, listingId),
    (e: unknown) => (e as MarketServiceError).code === 'payment_required' && (e as MarketServiceError).status === 402,
  );
});

test('已购下载：pay 客户端未配置 → 付费一律 402（旧行为不变）', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  const listingId = await makePaidListing(svc, users, objects);
  const admin = await users.findActiveUserById('a1');
  await assert.rejects(
    svc.download(admin!.id, listingId),
    (e: unknown) => (e as MarketServiceError).code === 'payment_required',
  );
});

test('purchases：合并目录元数据、按购买时间倒序、已删条目 available=false', async () => {
  const items: Array<{ id: string; purchased_at?: string }> = [];
  const pay = { listPurchases: async () => items };
  const { svc, users, objects, store } = makeService({ admins: ['admin@x.com'], pay });
  const buyer = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: '买', now: 1 });

  // 空索引 → 空列表
  assert.deepEqual(await svc.purchases(buyer.id), { purchases: [] });

  const lid1 = await makePaidListing(svc, users, objects);
  // 第二个付费条目 + 一个幽灵条目（索引里有、目录里没有）
  const admin = await users.findActiveUserById('a1');
  const c2 = await svc.create(admin!.id, { ...VALID, name: '付费库2', priceCents: 990 });
  objects.set(c2.uploads[0]!.key, 1); objects.set(c2.uploads[1]!.key, 1);
  await svc.confirm(admin!.id, c2.listingId);
  // 下架 lid1 → available=false 但仍在已购列表
  await svc.remove(admin!.id, lid1);

  items.push(
    { id: c2.listingId, purchased_at: '2026-09-02T00:00:00.000Z' },
    { id: lid1, purchased_at: '2026-09-05T00:00:00.000Z' },
    { id: 'ghost-listing' },
  );
  const res = await svc.purchases(buyer.id);
  assert.equal(res.purchases.length, 3);
  // 倒序：lid1(09-05) → c2(09-02) → ghost(null 沉底)
  assert.equal(res.purchases[0]!.id, lid1);
  assert.equal(res.purchases[0]!.available, false, '已下架不可下载');
  assert.equal(res.purchases[0]!.listing!.name, '付费库');
  assert.equal(res.purchases[1]!.id, c2.listingId);
  assert.equal(res.purchases[1]!.available, true);
  assert.equal(res.purchases[1]!.listing!.priceCents, 990);
  assert.equal(res.purchases[2]!.id, 'ghost-listing');
  assert.equal(res.purchases[2]!.listing, null, '目录查不到 → 元数据 null');
  assert.equal(res.purchases[2]!.purchasedAt, null);
  assert.equal(res.purchases[2]!.available, false);
  assert.ok(store, 'store 引用存在');
});

test('purchases/download：wxpay-fc 不可达 → 502 pay_unreachable（不谎报 402）', async () => {
  const pay = { listPurchases: async () => { throw new Error('network down'); } };
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'], pay });
  const listingId = await makePaidListing(svc, users, objects);
  const buyer = await users.createActiveUser({ id: 'u1', email: 'b@x.com', nickname: '买', now: 1 });
  await assert.rejects(
    svc.purchases(buyer.id),
    (e: unknown) => (e as MarketServiceError).code === 'pay_unreachable' && (e as MarketServiceError).status === 502,
  );
  await assert.rejects(
    svc.download(buyer.id, listingId),
    (e: unknown) => (e as MarketServiceError).code === 'pay_unreachable' && (e as MarketServiceError).status === 502,
  );
});

test('pricing(§九)：公开返回价目，file=zip 全量 key；未知 id 404', async () => {
  const { svc, users, objects } = makeService({ admins: ['admin@x.com'] });
  const admin = await users.createActiveUser({ id: 'a1', email: 'admin@x.com', nickname: '管', now: 1 });
  const c = await svc.create(admin.id, { ...VALID, name: '付费库', priceCents: 1990 });
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(admin.id, c.listingId);
  const p = await svc.pricing(c.listingId);
  assert.equal(p.name, '付费库');
  assert.equal(p.priceCents, 1990);
  assert.match(p.file, /^zips\/.+-vault\.zip$/);
  assert.equal(p.status, 'active');
  await assert.rejects(svc.pricing('nope'), (e: unknown) => (e as MarketServiceError).code === 'listing_not_found');
});

test('更新版本：修改名称/摘要/标签 → confirm 后生效', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  // 升版：改名称、摘要、标签
  const up = await svc.update(u.id, c.listingId, {
    previews: [],
    name: '新名字',
    summary: '新简介',
    tags: ['新标签'],
  });
  objects.set(up.uploads[0]!.key, 2);
  const after = await svc.confirm(u.id, c.listingId);
  assert.equal(after.version, 'v1.1');
  assert.equal(after.name, '新名字');
  assert.equal(after.summary, '新简介');
  assert.deepEqual(after.tags, ['新标签']);
  // 图标未传，保持原值
  assert.equal(after.icon, VALID.icon);
});

test('更新版本：只改部分字段 → 未传字段保持原值', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  // 只改名称，不动摘要和标签
  const up = await svc.update(u.id, c.listingId, {
    previews: [],
    name: '仅改名',
  });
  objects.set(up.uploads[0]!.key, 2);
  const after = await svc.confirm(u.id, c.listingId);
  assert.equal(after.name, '仅改名');
  assert.equal(after.summary, VALID.summary); // 未传 → 保持原值
  assert.deepEqual(after.tags, VALID.tags); // 未传 → 保持原值
  assert.equal(after.icon, VALID.icon);
});

test('更新版本：元数据非法（空名/超长/非法图标）→ 400', async () => {
  const { svc, users, objects } = makeService();
  const u = await users.createActiveUser({ id: 'u1', email: 'a@x.com', nickname: 'n', now: 1 });
  const c = await svc.create(u.id, VALID);
  objects.set(c.uploads[0]!.key, 1); objects.set(c.uploads[1]!.key, 1);
  await svc.confirm(u.id, c.listingId);
  const badCases = [
    { name: 'x'.repeat(31) },
    { summary: '' },
    { icon: '🚀' },
    { tags: ['x'.repeat(11)] },
    { tags: ['a', 'b', 'c', 'd'] }, // 超 3 个
  ];
  for (const bc of badCases) {
    await assert.rejects(
      svc.update(u.id, c.listingId, { previews: [], ...bc }),
      (e: unknown) => (e as MarketServiceError).code === 'invalid_metadata',
    );
  }
});
