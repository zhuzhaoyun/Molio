import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { MessageDedup } from '../../../src/core/channels/message-dedup.js';

describe('MessageDedup', () => {
  let originalNow: typeof Date.now;
  let clock: number;

  beforeEach(() => {
    originalNow = Date.now;
    clock = 1_000_000;
    Date.now = () => clock;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  function advance(ms: number): void {
    clock += ms;
  }

  describe('basic behavior', () => {
    it('first sight of an id returns false (not a duplicate)', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      assert.equal(d.check('m1'), false);
    });

    it('second sight of an id within TTL returns true (duplicate)', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      d.check('m1');
      assert.equal(d.check('m1'), true);
    });

    it('distinct ids are each processed once', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      assert.equal(d.check('m1'), false);
      assert.equal(d.check('m2'), false);
      assert.equal(d.check('m1'), true);
      assert.equal(d.check('m2'), true);
    });
  });

  describe('TTL expiry', () => {
    it('an id seen again after TTL is treated as new', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      d.check('m1');
      advance(60_001);
      assert.equal(d.check('m1'), false);
    });

    it('expired entries are swept before checking (no leak on quiet channel)', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      d.check('m1');
      d.check('m2');
      // Advance well past TTL for both.
      advance(120_000);
      // After the sweep, neither should be present.
      assert.equal(d.check('m1'), false);
      // 'm1' is now freshly inserted; m2 still in the past → swept.
      assert.equal(d.check('m2'), false);
    });
  });

  describe('maxEntries cap', () => {
    it('evicts the oldest entry when cap is reached (subsequent inserts evict in FIFO order)', () => {
      const d = new MessageDedup({ ttlMs: 60_000, maxEntries: 3 });
      // Insert 3 ids — all fit within the cap.
      d.check('m1');
      d.check('m2');
      d.check('m3');
      // All three should now be duplicates (no eviction triggered — re-check
      // short-circuits before the cap branch).
      assert.equal(d.check('m1'), true);
      assert.equal(d.check('m2'), true);
      assert.equal(d.check('m3'), true);
      // Insert a 4th — cap is reached, so m1 (oldest) gets evicted.
      assert.equal(d.check('m4'), false);
      // m2/m3/m4 are still present (they're the 3 most recent).
      assert.equal(d.check('m2'), true);
      assert.equal(d.check('m3'), true);
      assert.equal(d.check('m4'), true);
    });

    it('without maxEntries, the map grows until TTL sweeps (no eviction)', () => {
      const d = new MessageDedup({ ttlMs: 60_000 });
      for (let i = 0; i < 1000; i++) {
        d.check(`m${i}`);
      }
      // m500 is still within TTL — should be a duplicate.
      assert.equal(d.check('m500'), true);
    });
  });
});
