import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  warnOversizedDir,
  resetOversizedDirWarnState,
  OVERSIZED_DIR_WARN_INTERVAL_MS,
} from '../../src/core/vault-prune.js';

// The oversized-directory warning is throttled per (source, dir): during an
// active agent run the vault is rescanned many times a second, and each scan
// used to re-emit the same console.warn. Cloud log collectors treat every
// stderr line as an ERROR, so the un-throttled warning produced thousands of
// false anomalies. These tests pin the throttle behaviour.
describe('warnOversizedDir throttle', () => {
  let warnings: string[];
  let origWarn: typeof console.warn;

  before(() => {
    origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
  });
  after(() => {
    console.warn = origWarn;
  });

  function fresh(): void {
    resetOversizedDirWarnState();
    warnings = [];
  }

  it('warns once and suppresses repeats inside the interval', () => {
    fresh();
    const t0 = 1_000_000;
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0);
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 100);
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 200);
    assert.equal(warnings.length, 1, `expected 1 warning, got ${warnings.length}`);
    assert.match(warnings[0]!, /scanTree pruned oversized directory \(1365 entries, limit 1000\): \/vault\/dump/);
    // First emission has no suppressed-count suffix.
    assert.ok(!warnings[0]!.includes('suppressed'), 'first warning must not mention suppressed repeats');
  });

  it('re-warns after the interval and reports the suppressed count', () => {
    fresh();
    const t0 = 2_000_000;
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0);
    // Three repeats inside the window…
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 10);
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 20);
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 30);
    // …then the interval elapses.
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + OVERSIZED_DIR_WARN_INTERVAL_MS + 1);
    assert.equal(warnings.length, 2, `expected 2 warnings, got ${warnings.length}`);
    assert.match(warnings[1]!, /suppressed 3 repeat warnings in the previous interval/);
  });

  it('keeps separate state per directory', () => {
    fresh();
    const t0 = 3_000_000;
    warnOversizedDir('scanTree', '/vault/a', 1365, 1000, t0);
    warnOversizedDir('scanTree', '/vault/b', 1259, 1000, t0);
    // Both oversized dirs surface on the first scan — the user has two.
    assert.equal(warnings.length, 2, `expected 2 warnings, got ${warnings.length}`);
  });

  it('keeps separate state per source (scanTree vs countFiles)', () => {
    fresh();
    const t0 = 4_000_000;
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0);
    warnOversizedDir('countFiles', '/vault/dump', 1365, 1000, t0);
    assert.equal(warnings.length, 2, `expected 2 warnings, got ${warnings.length}`);
    assert.match(warnings[0]!, /scanTree pruned/);
    assert.match(warnings[1]!, /countFiles pruned/);
  });

  it('reset clears throttle state so the next call warns immediately', () => {
    fresh();
    const t0 = 5_000_000;
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0);
    resetOversizedDirWarnState();
    warnings = [];
    warnOversizedDir('scanTree', '/vault/dump', 1365, 1000, t0 + 1);
    assert.equal(warnings.length, 1, 'after reset the warning must fire again');
  });

  it('interval default is minutes-scale (collapses bursts, still resurfaces)', () => {
    assert.ok(OVERSIZED_DIR_WARN_INTERVAL_MS >= 60_000, 'interval should be at least a minute');
    assert.ok(OVERSIZED_DIR_WARN_INTERVAL_MS <= 60 * 60 * 1000, 'interval should be at most an hour');
  });
});
