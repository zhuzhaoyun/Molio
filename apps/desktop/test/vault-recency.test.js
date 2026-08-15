/**
 * Unit tests for vault-recency.js — the recently-opened vault LRU that backs
 * the macOS dock menu's 「最近使用的知识库」 submenu.
 *
 * The module is Electron-free: read/write are injected, so ordering, eviction,
 * and persistence round-trips are tested directly without a window.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVaultRecency } from '../src/vault-recency.js';

describe('vault-recency: ordering', () => {
  it('returns ids most-recently-used first', () => {
    let t = 0;
    const rec = createVaultRecency({ now: () => ++t });
    rec.touch('a');
    rec.touch('b');
    rec.touch('c');
    assert.deepEqual(rec.orderedIds(), ['c', 'b', 'a']);
  });

  it('re-touching a vault moves it to the front without duplication', () => {
    let t = 0;
    const rec = createVaultRecency({ now: () => ++t });
    rec.touch('a');
    rec.touch('b');
    rec.touch('a'); // b was newest, now a jumps back to front
    assert.deepEqual(rec.orderedIds(), ['a', 'b']);
  });

  it('ignores empty / non-string ids', () => {
    const rec = createVaultRecency({ now: () => 1 });
    rec.touch('');
    rec.touch(null);
    rec.touch(undefined);
    rec.touch(42);
    assert.deepEqual(rec.orderedIds(), []);
  });

  it('evicts the least-recently-used beyond the configured limit', () => {
    let t = 0;
    const rec = createVaultRecency({ now: () => ++t, limit: 2 });
    rec.touch('a');
    rec.touch('b');
    rec.touch('c'); // 'a' is now oldest and must be evicted
    assert.deepEqual(rec.orderedIds(), ['c', 'b']);
  });
});

describe('vault-recency: persistence', () => {
  it('round-trips through injected read/write', () => {
    let stored = null;
    const rec = createVaultRecency({
      read: () => stored,
      write: (data) => { stored = data; },
      now: () => 5,
    });
    rec.touch('v1');
    assert.ok(Array.isArray(stored), 'touch must persist via write');
    assert.deepEqual(stored, [{ id: 'v1', lastUsed: 5 }]);

    // A fresh instance built from the same storage sees the same ordering.
    const rec2 = createVaultRecency({
      read: () => stored,
      write: (data) => { stored = data; },
      now: () => 6,
    });
    rec2.touch('v2');
    assert.deepEqual(rec2.orderedIds(), ['v2', 'v1']);
  });

  it('starts empty when read returns non-array / throws (corrupt file)', () => {
    const corrupt = createVaultRecency({ read: () => 'not-json', now: () => 1 });
    assert.deepEqual(corrupt.orderedIds(), []);
    const throws = createVaultRecency({ read: () => { throw new Error('io'); }, now: () => 1 });
    assert.deepEqual(throws.orderedIds(), []);
  });

  it('filters malformed persisted entries instead of crashing', () => {
    const rec = createVaultRecency({
      read: () => [
        { id: 'ok', lastUsed: 10 },
        { id: 'no-ts' },
        { lastUsed: 20 },
        'garbage',
        { id: 5, lastUsed: 30 },
        { id: 'bad-ts', lastUsed: 'x' },
      ],
      now: () => 1,
    });
    assert.deepEqual(rec.orderedIds(), ['ok']);
  });

  it('does not throw when write fails (persistence is best-effort)', () => {
    const rec = createVaultRecency({
      read: () => null,
      write: () => { throw new Error('disk full'); },
      now: () => 1,
    });
    assert.doesNotThrow(() => rec.touch('v1'));
    assert.deepEqual(rec.orderedIds(), ['v1']);
  });
});
