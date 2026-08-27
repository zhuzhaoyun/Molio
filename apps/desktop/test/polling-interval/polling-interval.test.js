/**
 * polling-interval.js — 两个轮询器共用的 env 间隔解析。
 *
 * 红线：负数/零/低于下限/非数字/Infinity 必须回落 defaultMs——
 * setInterval 会把 <=0 夹到 1ms，误配会变成对 daemon 的请求风暴。
 * （Number('-1') 是 truthy，naive `Number(x) || fallback` 会漏负数。）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePollIntervalMs, MIN_POLL_INTERVAL_MS } from '../../src/polling-interval.js';

describe('resolvePollIntervalMs', () => {
  it('accepts finite values at/above the floor', () => {
    assert.equal(resolvePollIntervalMs('1000', 15_000), 1000);
    assert.equal(resolvePollIntervalMs('30000', 15_000), 30_000);
    assert.equal(resolvePollIntervalMs('2000', 60_000), 2000);
  });

  it('falls back to the caller default for sub-floor/negative/non-numeric', () => {
    for (const bad of ['-1', '-100000', '0', '999', '50', 'abc', 'NaN', '', undefined, 'Infinity']) {
      assert.equal(resolvePollIntervalMs(bad, 15_000), 15_000, `15s default for ${String(bad)}`);
      assert.equal(resolvePollIntervalMs(bad, 60_000), 60_000, `60s default for ${String(bad)}`);
    }
  });

  it('honors a custom minMs', () => {
    assert.equal(resolvePollIntervalMs('500', 15_000, 500), 500);
    assert.equal(resolvePollIntervalMs('499', 15_000, 500), 15_000);
  });

  it('MIN_POLL_INTERVAL_MS is 1s', () => {
    assert.equal(MIN_POLL_INTERVAL_MS, 1_000);
  });
});
