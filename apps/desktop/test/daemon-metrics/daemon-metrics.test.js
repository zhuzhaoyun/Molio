import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startDaemonMetricsPolling } from '../../src/daemon-metrics.js';

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

    process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS = '50';
    stop = startDaemonMetricsPolling({
      armsRum: mockArmsRum,
      daemonPort: 3100,
      log: () => {},
    });
    delete process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS;

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

    process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS = '50';
    stop = startDaemonMetricsPolling({
      armsRum: mockArmsRum,
      daemonPort: 3100,
      log: () => {},
    });
    delete process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS;

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

    process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS = '50';
    stop = startDaemonMetricsPolling({
      armsRum: null,
      daemonPort: 3100,
      log: () => {},
    });
    delete process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS;

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

    process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS = '50';
    stop = startDaemonMetricsPolling({
      armsRum: { sendCustom: () => {} },
      daemonPort: 3100,
      log: () => {},
    });
    delete process.env.MOLIO_DAEMON_METRICS_INTERVAL_MS;

    await new Promise((r) => setTimeout(r, 120));
    stop();
    stop = null;
    const countAtStop = fetchCount;
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(fetchCount, countAtStop, 'no more fetches after stop()');
  });
});
