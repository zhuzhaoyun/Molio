/**
 * Regression tests for retry.js — the backoff logic used by the auto-updater.
 *
 * This module has ZERO Electron dependencies, so it runs in plain Node.js.
 * If any PR breaks the retry logic, these tests will catch it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRetryDelay, createRetryState, RETRY_DELAYS } from '../../src/retry.js';

describe('RETRY_DELAYS', () => {
  it('should have exactly 5 delay levels', () => {
    assert.equal(RETRY_DELAYS.length, 5);
  });

  it('should start at 30 seconds', () => {
    assert.equal(RETRY_DELAYS[0], 30_000);
  });

  it('should end at 15 minutes', () => {
    assert.equal(RETRY_DELAYS[4], 900_000);
  });

  it('should be strictly increasing', () => {
    for (let i = 1; i < RETRY_DELAYS.length; i++) {
      assert.ok(RETRY_DELAYS[i] > RETRY_DELAYS[i - 1],
        `RETRY_DELAYS[${i}] (${RETRY_DELAYS[i]}) should be > RETRY_DELAYS[${i - 1}] (${RETRY_DELAYS[i - 1]})`);
    }
  });

  it('all delays should be under 1 hour (less than poll interval)', () => {
    const ONE_HOUR = 60 * 60 * 1000;
    for (const d of RETRY_DELAYS) {
      assert.ok(d < ONE_HOUR, `${d}ms should be < 1 hour`);
    }
  });
});

describe('getRetryDelay', () => {
  it('should return first delay for attempt 0', () => {
    assert.equal(getRetryDelay(0), 30_000);
  });

  it('should return correct delays for each attempt', () => {
    assert.equal(getRetryDelay(0), 30_000);
    assert.equal(getRetryDelay(1), 60_000);
    assert.equal(getRetryDelay(2), 120_000);
    assert.equal(getRetryDelay(3), 300_000);
    assert.equal(getRetryDelay(4), 900_000);
  });

  it('should cap at last delay for attempts beyond array length', () => {
    assert.equal(getRetryDelay(5), 900_000);
    assert.equal(getRetryDelay(10), 900_000);
    assert.equal(getRetryDelay(100), 900_000);
  });

  it('should handle negative attempt by returning first delay', () => {
    assert.equal(getRetryDelay(-1), 30_000);
  });
});

describe('createRetryState', () => {
  it('should start at attempt 0', () => {
    const state = createRetryState();
    assert.equal(state.attempt, 0);
  });

  it('should return increasing delays on each .next() call', () => {
    const state = createRetryState();
    assert.equal(state.next(), 30_000);
    assert.equal(state.next(), 60_000);
    assert.equal(state.next(), 120_000);
    assert.equal(state.next(), 300_000);
    assert.equal(state.next(), 900_000);
    // Should cap at last delay
    assert.equal(state.next(), 900_000);
  });

  it('should increment attempt after each .next()', () => {
    const state = createRetryState();
    assert.equal(state.attempt, 0);
    state.next();
    assert.equal(state.attempt, 1);
    state.next();
    assert.equal(state.attempt, 2);
  });

  it('should reset attempt to 0', () => {
    const state = createRetryState();
    state.next();
    state.next();
    state.next();
    assert.equal(state.attempt, 3);
    state.reset();
    assert.equal(state.attempt, 0);
    assert.equal(state.next(), 30_000);
  });

  it('multiple instances should be independent', () => {
    const a = createRetryState();
    const b = createRetryState();
    a.next();
    a.next();
    assert.equal(a.attempt, 2);
    assert.equal(b.attempt, 0);
    b.reset();
    assert.equal(a.attempt, 2); // unaffected
  });
});
