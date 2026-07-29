import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { dbgLog } from '../../src/core/debug-log.js';

// dbgLog is a low-frequency SSE/RunManager diagnostic that also tees to
// ~/.molio/debug/sse-debug.log. It must emit through console.log (stdout), NOT
// console.warn/error (stderr): cloud log collectors (Logtail/SLS) classify
// every stderr line as an ERROR, so routing routine diagnostics through stderr
// floods the monitor with false-positive anomalies. These tests pin that
// channel contract so a future "make it look more serious" tweak can't silently
// regress it back to stderr.
describe('dbgLog output channel', () => {
  let logs: string[];
  let warnings: string[];
  let errors: string[];
  let origLog: typeof console.log;
  let origWarn: typeof console.warn;
  let origError: typeof console.error;

  before(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };
  });
  after(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  function fresh(): void {
    logs = [];
    warnings = [];
    errors = [];
  }

  it('writes to stdout via console.log with the [sse-daemon] prefix', () => {
    fresh();
    dbgLog('abort runId=abc socket.destroyed=true remote=undefined:undefined');
    assert.equal(logs.length, 1, `expected 1 stdout line, got ${logs.length}`);
    assert.match(logs[0]!, /^\[sse-daemon\] abort runId=abc socket\.destroyed=true remote=undefined:undefined$/);
  });

  it('does not write to stderr (console.warn / console.error)', () => {
    fresh();
    dbgLog('subscribe runId=abc listeners=1');
    assert.equal(warnings.length, 0, `dbgLog must not use console.warn, got: ${warnings.join(' | ')}`);
    assert.equal(errors.length, 0, `dbgLog must not use console.error, got: ${errors.join(' | ')}`);
  });
});
