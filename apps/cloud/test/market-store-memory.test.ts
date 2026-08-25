// apps/cloud/test/market-store-memory.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryMarketStore } from '../src/store/market-memory.js';
import type { MarketListingRecord } from '../src/store/market-types.js';

function rec(id: string, over: Partial<MarketListingRecord> = {}): MarketListingRecord {
  return {
    id, userId: 'u1', source: 'community', name: 'n', icon: '📖', tint: '#E8EDF2',
    summary: 's', overview: [], highlights: [], tags: [], previews: [],
    version: 'v1.0', priceCents: 0, payUrl: '', authorDisplay: null,
    ossKey: `resources/${id}-vault.zip`, fileSize: null,
    status: 'uploading', removedReason: null,
    createdAt: 1000, updatedAt: 1000, publishedAt: null, ...over,
  };
}

test('insert/find/update 状态机', async () => {
  const s = new MemoryMarketStore();
  await s.insertListing(rec('a'));
  const got = await s.updateListing('a', { status: 'active', fileSize: 123, publishedAt: 2000 }, 2000);
  assert.equal(got?.status, 'active');
  assert.equal((await s.findListingById('a'))?.fileSize, 123);
  assert.equal(await s.updateListing('nope', { status: 'active' }, 2000), null);
});

test('active 列表按 publishedAt 倒序，排除非 active', async () => {
  const s = new MemoryMarketStore();
  await s.insertListing(rec('a', { status: 'active', publishedAt: 100 }));
  await s.insertListing(rec('b', { status: 'active', publishedAt: 300 }));
  await s.insertListing(rec('c', { status: 'removed', publishedAt: 900 }));
  const list = await s.listActiveListings(10);
  assert.deepEqual(list.map((r) => r.id), ['b', 'a']);
});

test('限频计数与僵尸清理', async () => {
  const s = new MemoryMarketStore();
  await s.insertListing(rec('a', { status: 'active' }));
  await s.insertListing(rec('b', { status: 'removed' }));
  await s.insertListing(rec('c', { createdAt: 500 }));
  assert.equal(await s.countActiveByUser('u1'), 1);
  assert.equal(await s.countUserCreationsSince('u1', 0), 3);
  assert.equal(await s.countUserCreationsSince('u1', 1000), 0);
  assert.equal(await s.deleteStaleUploading(999), 1);
  assert.equal((await s.findListingById('c')), null);
});
