import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryAuthStore } from '../src/store/memory.js';
import { UniqueViolationError } from '../src/store/types.js';
import type { AuthCodeRecord, RefreshTokenRecord } from '../src/store/types.js';

const T0 = 1_750_000_000_000;

function makeCode(over: Partial<AuthCodeRecord> = {}): AuthCodeRecord {
  return {
    id: over.id ?? 'code-1',
    email: 'u@example.com',
    codeHash: 'hash',
    expiresAt: T0 + 300_000,
    attempts: 0,
    consumedAt: null,
    ip: '1.2.3.4',
    createdAt: T0,
    ...over,
  };
}

function makeToken(over: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    id: over.id ?? 'tok-1',
    userId: 'user-1',
    tokenHash: 'thash',
    deviceHint: null,
    createdAt: T0,
    expiresAt: T0 + 30 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    replacedBy: null,
    ...over,
  };
}

test('store: createActiveUser 主键冲突 → UniqueViolationError（与 PG 行为一致）', async () => {
  const s = new MemoryAuthStore();
  await s.createActiveUser({ id: 'user-1', email: 'a@example.com', nickname: '墨友0001', now: T0 });
  await assert.rejects(
    () => s.createActiveUser({ id: 'user-1', email: 'b@example.com', nickname: '墨友0002', now: T0 }),
    UniqueViolationError,
  );
});

test('store: createActiveUser 活跃邮箱冲突 → UniqueViolationError；软删除后可复用', async () => {
  const s = new MemoryAuthStore();
  const u = await s.createActiveUser({ id: 'user-1', email: 'a@example.com', nickname: '墨友0001', now: T0 });
  await assert.rejects(
    () => s.createActiveUser({ id: 'user-2', email: 'a@example.com', nickname: '墨友0002', now: T0 }),
    UniqueViolationError,
  );
  await s.softDeleteUser(u.id, T0 + 1000);
  const again = await s.createActiveUser({ id: 'user-3', email: 'a@example.com', nickname: '墨友0003', now: T0 + 2000 });
  assert.equal(again.id, 'user-3');
});

test('store: createActiveUser 持久化 nickname', async () => {
  const s = new MemoryAuthStore();
  const u = await s.createActiveUser({ id: 'user-1', email: 'a@example.com', nickname: '墨友1234', now: T0 });
  assert.equal(u.nickname, '墨友1234');
  assert.equal((await s.findActiveUserById('user-1'))!.nickname, '墨友1234');
});

test('store: updateUserNickname 更新昵称 + updatedAt；未知/已注销账号返回 null', async () => {
  const s = new MemoryAuthStore();
  await s.createActiveUser({ id: 'user-1', email: 'a@example.com', nickname: '墨友0001', now: T0 });

  const updated = await s.updateUserNickname('user-1', '新昵称', T0 + 1000);
  assert.equal(updated!.nickname, '新昵称');
  assert.equal(updated!.updatedAt, T0 + 1000);
  assert.equal((await s.findActiveUserById('user-1'))!.nickname, '新昵称');

  assert.equal(await s.updateUserNickname('nonexistent', 'x', T0), null);
  await s.softDeleteUser('user-1', T0 + 2000);
  assert.equal(await s.updateUserNickname('user-1', 'y', T0 + 3000), null, '已注销账号不可改昵称');
});

test('store: find* 返回防御性拷贝——改返回值不污染内部状态', async () => {
  const s = new MemoryAuthStore();
  await s.createActiveUser({ id: 'user-1', email: 'a@example.com', nickname: '墨友0001', now: T0 });

  const u = await s.findActiveUserById('user-1');
  assert.ok(u);
  u!.email = 'hacked@example.com';
  assert.equal((await s.findActiveUserById('user-1'))!.email, 'a@example.com');

  const t = makeToken();
  await s.insertRefreshToken(t);
  const found = await s.findRefreshTokenByHash('thash');
  found!.revokedAt = T0; // 外部篡改不影响 store
  assert.equal((await s.findRefreshTokenById('tok-1'))!.revokedAt, null);
});

test('store: revokeRefreshToken 原子语义——首次 true，重复/未知 false', async () => {
  const s = new MemoryAuthStore();
  await s.insertRefreshToken(makeToken());
  assert.equal(await s.revokeRefreshToken('tok-1', T0 + 1000, 'tok-2'), true);
  // 已被吊销（并发竞态后到一方）→ false，且不覆盖 replacedBy
  assert.equal(await s.revokeRefreshToken('tok-1', T0 + 2000, 'tok-3'), false);
  const rec = await s.findRefreshTokenById('tok-1');
  assert.equal(rec!.replacedBy, 'tok-2');
  assert.equal(rec!.revokedAt, T0 + 1000);
  assert.equal(await s.revokeRefreshToken('nonexistent', T0, null), false);
});

test('store: consumeCode 原子一次性 + 未知码返回 false', async () => {
  const s = new MemoryAuthStore();
  await s.insertCode(makeCode());
  assert.equal(await s.consumeCode('code-1', T0 + 1000), true);
  assert.equal(await s.consumeCode('code-1', T0 + 2000), false);
  assert.equal(await s.consumeCode('nonexistent', T0), false);
});

test('store: 限频窗口统计——email 与 ip 各自独立', async () => {
  const s = new MemoryAuthStore();
  await s.insertCode(makeCode({ id: 'c1' }));
  await s.insertCode(makeCode({ id: 'c2', email: 'other@example.com', createdAt: T0 + 1000 }));
  await s.insertCode(makeCode({ id: 'c3', ip: '9.9.9.9', createdAt: T0 + 2000 }));

  assert.equal(await s.countCodesForEmailSince('u@example.com', T0), 2);
  assert.equal(await s.oldestCodeForEmailSince('u@example.com', T0), T0);
  assert.equal(await s.countCodesForIpSince('1.2.3.4', T0), 2);
  assert.equal(await s.oldestCodeForIpSince('9.9.9.9', T0), T0 + 2000);
  // since 晚于全部记录 → null
  assert.equal(await s.oldestCodeForIpSince('1.2.3.4', T0 + 1500), null);
  assert.equal(await s.oldestCodeForEmailSince('nobody@example.com', T0), null);
});

test('store: latestCodeForEmail 同毫秒插入按 ULID id 决胜（与 PG ORDER BY 一致）', async () => {
  const s = new MemoryAuthStore();
  // 同 createdAt，id 更大 = 更晚插入（ULID 时间有序）
  await s.insertCode(makeCode({ id: 'AAA', createdAt: T0 }));
  await s.insertCode(makeCode({ id: 'BBB', createdAt: T0 }));
  const latest = await s.latestCodeForEmail('u@example.com');
  assert.equal(latest!.id, 'BBB');
});

test('store: 机会清理——超过 2 天窗口的旧记录随新插入被清除', async () => {
  const s = new MemoryAuthStore();
  await s.insertCode(makeCode({ id: 'old', createdAt: T0 }));
  await s.insertRefreshToken(makeToken({ id: 'old-tok', expiresAt: T0 + 1000 }));

  const DAY = 24 * 60 * 60 * 1000;
  // 3 天后插入新记录触发清理：旧码（createdAt 超窗）与过期 token 被移除
  await s.insertCode(makeCode({ id: 'new', createdAt: T0 + 3 * DAY }));
  await s.insertRefreshToken(makeToken({ id: 'new-tok', createdAt: T0 + 3 * DAY }));

  assert.equal(await s.countCodesForEmailSince('u@example.com', T0), 1, '旧码应被清理');
  assert.equal(await s.findRefreshTokenById('old-tok'), null, '过期 token 应被清理');
  assert.ok(await s.findRefreshTokenById('new-tok'));
});

test('store: 机会清理不误删限频窗口内的记录', async () => {
  const s = new MemoryAuthStore();
  const DAY = 24 * 60 * 60 * 1000;
  // 12 小时前的码仍在 1 天限频窗口内，2 天清理窗口必须保留它
  await s.insertCode(makeCode({ id: 'recent', createdAt: T0 }));
  await s.insertCode(makeCode({ id: 'trigger', createdAt: T0 + DAY / 2 }));
  assert.equal(await s.countCodesForEmailSince('u@example.com', T0), 2);
});
