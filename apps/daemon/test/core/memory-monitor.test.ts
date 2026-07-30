import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMemoryMonitor } from '../../src/core/memory-monitor.js';

describe('memory-monitor', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('should return a stop function', () => {
    stop = startMemoryMonitor({ intervalMs: 100_000 }); // long interval — no tick
    assert.equal(typeof stop, 'function');
  });

  it('should log a sample via dbgLog (stdout, not stderr)', async () => {
    // Capture stdout writes
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

    try {
      stop = startMemoryMonitor({ intervalMs: 50 });
      // Wait for at least one tick
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      console.log = origLog;
    }

    const memLines = lines.filter((l) => l.includes('[memory-monitor]'));
    assert.ok(memLines.length >= 1, 'should have at least one memory sample');
    const first = memLines[0]!;
    assert.ok(first.includes('rss='), 'sample should include rss');
    assert.ok(first.includes('heapUsed='), 'sample should include heapUsed');
    assert.ok(first.includes('uptime='), 'sample should include uptime');
  });

  it('should include context from getContext callback', async () => {
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

    try {
      stop = startMemoryMonitor({
        intervalMs: 50,
        getContext: () => 'activeRuns=3',
      });
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      console.log = origLog;
    }

    const memLines = lines.filter((l) => l.includes('[memory-monitor]'));
    assert.ok(memLines.length >= 1);
    assert.ok(memLines[0]!.includes('activeRuns=3'), 'should include custom context');
  });

  it('should warn when RSS exceeds threshold', async () => {
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

    try {
      // Set threshold to 1 MB — any process will exceed this
      stop = startMemoryMonitor({ intervalMs: 50, thresholdMB: 1 });
      await new Promise((r) => setTimeout(r, 120));
    } finally {
      console.log = origLog;
    }

    const warnLines = lines.filter((l) => l.includes('HIGH RSS'));
    assert.ok(warnLines.length >= 1, 'should warn about high RSS');
    assert.ok(warnLines[0]!.includes('exceeds threshold 1MB'), 'should mention threshold');
  });

  it('should throttle repeated high-RSS warnings', async () => {
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };

    try {
      // ThrottledWarn default interval is 5 min, so within 300ms only 1 warning
      stop = startMemoryMonitor({ intervalMs: 50, thresholdMB: 1 });
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      console.log = origLog;
    }

    const warnLines = lines.filter((l) => l.includes('HIGH RSS'));
    // Multiple samples but only 1 warning (throttled)
    const sampleLines = lines.filter((l) => l.includes('[memory-monitor] rss='));
    assert.ok(sampleLines.length >= 2, 'should have multiple samples');
    assert.equal(warnLines.length, 1, 'high-RSS warning should be throttled to 1');
  });

  it('should stop sampling after stop() is called', async () => {
    const origLog = console.log;
    let count = 0;
    console.log = (...args: unknown[]) => {
      if (args.join(' ').includes('[memory-monitor]')) count++;
    };

    try {
      stop = startMemoryMonitor({ intervalMs: 50 });
      await new Promise((r) => setTimeout(r, 120));
      stop();
      stop = null;
      const countAtStop = count;
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(count, countAtStop, 'no more samples after stop()');
    } finally {
      console.log = origLog;
    }
  });
});
