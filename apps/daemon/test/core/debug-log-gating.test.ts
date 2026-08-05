import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Regression test: dbgLog is a DEBUG-level channel and must be SILENT in
 * production (no MOLIO_DEBUG=1) — previously it appended to
 * ~/.molio/debug/sse-debug.log and wrote to the console unconditionally on
 * every long-running daemon. This file runs in its own process (node --test)
 * with MOLIO_DEBUG unset so the module-load gate reads the production value.
 */

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'molio-debug-gate-test-'));
process.env['MOLIO_DEBUG_LOG_DIR'] = tmpDir;
delete process.env['MOLIO_DEBUG'];

const { dbgLog, isDebugEnabled } = await import('../../src/core/debug-log.js');

after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('dbgLog level gating', () => {
  it('should report disabled when MOLIO_DEBUG is not set', () => {
    assert.equal(isDebugEnabled(), false);
  });

  it('should not write any file or throw when disabled', () => {
    dbgLog('this must not be persisted');
    assert.equal(existsSync(path.join(tmpDir, 'sse-debug.log')), false);
    assert.equal(existsSync(path.join(tmpDir, 'sse-debug.log.old')), false);
  });
});
