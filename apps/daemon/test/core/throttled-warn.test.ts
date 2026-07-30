import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ThrottledWarn,
  DEFAULT_WARN_INTERVAL_MS,
} from '../../src/core/throttled-warn.js';

// ThrottledWarn is the canonical "warn at most once per interval per key"
// helper. It exists so stable, expected daemon conditions (oversized vault dir,
// flapping watcher, missing skills source) stop flooding stderr — which cloud
// log collectors classify as ERROR — while still resurfacing periodically with
// a suppressed-repeat count. These tests pin that contract.
describe('ThrottledWarn', () => {
  it('emits once and suppresses repeats inside the interval', () => {
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 1_000_000;
    assert.equal(w.warn('k', 'boom', t0), true);
    assert.equal(w.warn('k', 'boom', t0 + 100), false);
    assert.equal(w.warn('k', 'boom', t0 + 200), false);
    assert.equal(out.length, 1, `expected 1 emission, got ${out.length}`);
    assert.equal(out[0], 'boom'); // first emission has no suppressed suffix
  });

  it('re-emits after the interval and reports the suppressed count', () => {
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 2_000_000;
    w.warn('k', 'boom', t0);
    w.warn('k', 'boom', t0 + 10);
    w.warn('k', 'boom', t0 + 20);
    w.warn('k', 'boom', t0 + 30);
    // Interval elapses → the folded repeats surface in the next emission.
    w.warn('k', 'boom', t0 + 1000 + 1);
    assert.equal(out.length, 2, `expected 2 emissions, got ${out.length}`);
    assert.match(out[1]!, /boom \(suppressed 3 repeat warnings in the previous interval\)/);
  });

  it('uses the singular suffix for exactly one suppressed repeat', () => {
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 3_000_000;
    w.warn('k', 'boom', t0);
    w.warn('k', 'boom', t0 + 10);
    w.warn('k', 'boom', t0 + 1000 + 1);
    assert.match(out[1]!, /\(suppressed 1 repeat warning in the previous interval\)/);
  });

  it('keeps separate state per key', () => {
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 4_000_000;
    assert.equal(w.warn('a', 'A', t0), true);
    assert.equal(w.warn('b', 'B', t0), true);
    assert.equal(w.warn('a', 'A', t0 + 1), false);
    assert.equal(w.warn('b', 'B', t0 + 1), false);
    assert.equal(out.length, 2);
  });

  it('reset clears state so the next call emits immediately', () => {
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 5_000_000;
    w.warn('k', 'boom', t0);
    w.warn('k', 'boom', t0 + 1);
    w.reset();
    assert.equal(w.warn('k', 'boom', t0 + 2), true);
    assert.equal(out.length, 2);
  });

  it('delete(key) drops a single key so only it re-emits immediately', () => {
    // Per-entity keys (e.g. RunManager's run UUIDs) need targeted cleanup when
    // the entity is destroyed, otherwise the state map grows unbounded. delete()
    // must free just that key while leaving other keys throttled.
    const out: string[] = [];
    const w = new ThrottledWarn({ intervalMs: 1000, sink: (m) => out.push(m) });
    const t0 = 7_000_000;
    w.warn('a', 'A', t0);
    w.warn('b', 'B', t0);
    assert.equal(w.warn('a', 'A', t0 + 1), false); // throttled inside interval
    w.delete('a');
    assert.equal(w.warn('a', 'A', t0 + 2), true); // freed → re-emits
    assert.equal(w.warn('b', 'B', t0 + 2), false); // 'b' untouched, still throttled
    assert.deepEqual(out, ['A', 'B', 'A']);
  });

  it('defaults to console.warn (stderr), never console.log/error', () => {
    // The default sink must stay on the warning channel; the whole point is to
    // *reduce* volume, not to silently reroute real warnings to stdout.
    const warnings: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    const origError = console.error;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
      const w = new ThrottledWarn({ intervalMs: 1000 });
      w.warn('k', 'real warning', 6_000_000);
      assert.equal(warnings.length, 1);
      assert.equal(logs.length, 0, 'default sink must not use console.log');
      assert.equal(errors.length, 0, 'default sink must not use console.error');
    } finally {
      console.warn = origWarn;
      console.log = origLog;
      console.error = origError;
    }
  });

  it('default interval is minutes-scale (collapses bursts, still resurfaces)', () => {
    assert.ok(DEFAULT_WARN_INTERVAL_MS >= 60_000, 'interval should be at least a minute');
    assert.ok(DEFAULT_WARN_INTERVAL_MS <= 60 * 60 * 1000, 'interval should be at most an hour');
  });
});
