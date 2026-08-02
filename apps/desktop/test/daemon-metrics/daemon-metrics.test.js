import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemonMetricsPolling, resolveIntervalMs } from '../../src/daemon-metrics.js';

// The timing-based tests below inject a fast interval via the `intervalMs`
// option (bypassing the 1000ms production floor) so they run quickly.
const FAST_INTERVAL = 50;

describe('resolveIntervalMs', () => {
  it('returns a valid interval at or above the 1000ms floor', () => {
    assert.equal(resolveIntervalMs('2000'), 2000);
    assert.equal(resolveIntervalMs('1000'), 1000);
  });

  it('falls back to the 60s default for a negative value', () => {
    // Regression: Number('-1') is truthy, so `Number(x) || fallback` let -1
    // through and setInterval(fn, -1) clamped to 1ms — flooding the daemon.
    assert.equal(resolveIntervalMs('-1'), 60_000);
    assert.equal(resolveIntervalMs('-100000'), 60_000);
  });

  it('falls back to the default for zero / sub-floor values', () => {
    assert.equal(resolveIntervalMs('0'), 60_000);
    assert.equal(resolveIntervalMs('999'), 60_000);
    assert.equal(resolveIntervalMs('50'), 60_000);
  });

  it('falls back to the default for non-numeric / missing values', () => {
    assert.equal(resolveIntervalMs(undefined), 60_000);
    assert.equal(resolveIntervalMs(''), 60_000);
    assert.equal(resolveIntervalMs('abc'), 60_000);
    assert.equal(resolveIntervalMs('NaN'), 60_000);
    assert.equal(resolveIntervalMs('Infinity'), 60_000);
  });
});

describe('startDaemonMetricsPolling', () => {
  let stop = null;
  let origFetch;

  beforeEach(() => {
    origFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (stop) { stop(); stop = null; }
    globalThis.fetch = origFetch;
  });

  it('should call sendCustom with daemon memory data', async () => {
    const calls = [];
    const mockArmsRum = {
      sendCustom: (payload) => calls.push(payload),
    };

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        memory: { rss: 500_000_000, heapTotal: 400_000_000, heapUsed: 350_000_000, external: 8_000_000, arrayBuffers: 2_000_000 },
        activeRuns: 2,
        uptime: 3600,
      }),
    });

    stop = startDaemonMetricsPolling({
      armsRum: mockArmsRum,
      daemonPort: 3100,
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });

    await new Promise((r) => setTimeout(r, 120));

    assert.ok(calls.length >= 1, 'should have called sendCustom');
    const call = calls[0];
    assert.equal(call.type, 'daemon_memory');
    assert.equal(call.name, 'health_poll');
    assert.equal(call.value, 500_000_000);
    assert.equal(call.group, 'daemon');
    assert.equal(call.properties.activeRuns, 2);
    assert.equal(call.properties.uptime, 3600);
  });

  it('should skip sendCustom when daemon is unreachable', async () => {
    const calls = [];
    const mockArmsRum = {
      sendCustom: (payload) => calls.push(payload),
    };

    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };

    stop = startDaemonMetricsPolling({
      armsRum: mockArmsRum,
      daemonPort: 3100,
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(calls.length, 0, 'should not call sendCustom when daemon is down');
  });

  it('should skip sendCustom when armsRum is null', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        status: 'ok',
        memory: { rss: 100, heapTotal: 100, heapUsed: 100, external: 0, arrayBuffers: 0 },
        activeRuns: 0,
        uptime: 10,
      }),
    });

    stop = startDaemonMetricsPolling({
      armsRum: null,
      daemonPort: 3100,
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });

    // If it doesn't throw, the null guard works
    await new Promise((r) => setTimeout(r, 120));
  });

  it('should stop polling after stop() is called', async () => {
    let fetchCount = 0;
    globalThis.fetch = async () => {
      fetchCount++;
      return {
        ok: true,
        json: async () => ({
          status: 'ok',
          memory: { rss: 100, heapTotal: 100, heapUsed: 100, external: 0, arrayBuffers: 0 },
          activeRuns: 0,
          uptime: 10,
        }),
      };
    };

    stop = startDaemonMetricsPolling({
      armsRum: { sendCustom: () => {} },
      daemonPort: 3100,
      log: () => {},
      intervalMs: FAST_INTERVAL,
    });

    await new Promise((r) => setTimeout(r, 120));
    stop();
    stop = null;
    const countAtStop = fetchCount;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fetchCount, countAtStop, 'no more fetches after stop()');
  });
});
