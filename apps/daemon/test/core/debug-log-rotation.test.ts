import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Regression test: sse-debug.log previously appended forever (appendFileSync,
 * no rotation) — 1.4MB+ and climbing after weeks of runtime. dbgLog must
 * rotate the file once it exceeds MAX_DEBUG_LOG_BYTES.
 *
 * MOLIO_DEBUG and MOLIO_DEBUG_LOG_DIR are set BEFORE the module is imported
 * (debug-log reads them at module-load time). node --test runs each file in
 * its own process, so the env overrides are isolated to this suite.
 */

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'molio-debug-log-test-'));
process.env['MOLIO_DEBUG'] = '1';
process.env['MOLIO_DEBUG_LOG_DIR'] = tmpDir;

const { dbgLog, MAX_DEBUG_LOG_BYTES } = await import('../../src/core/debug-log.js');

const LOG_PATH = path.join(tmpDir, 'sse-debug.log');
const OLD_PATH = LOG_PATH + '.old';

// Clean up the temp dir once the suite finishes.
process.on('exit', () => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Pre-grow the live log just past the cap (fast, no 2000-line loop). */
function seedOversizedLog(marker: string): void {
  writeFileSync(LOG_PATH, `# ${marker}\n` + 'x'.repeat(MAX_DEBUG_LOG_BYTES + 1024));
}

describe('dbgLog rotation', () => {
  it('should write lines to the debug log', () => {
    dbgLog('hello rotation');
    assert.ok(existsSync(LOG_PATH));
    const content = readFileSync(LOG_PATH, 'utf8');
    assert.ok(content.includes('hello rotation'));
  });

  it('should rotate to .old when the next write would exceed the size cap', () => {
    seedOversizedLog('gen-one');

    dbgLog('post-rotation line');

    assert.ok(existsSync(OLD_PATH), '.old rotation file should exist');
    // The live log restarts with just the new line.
    const size = statSync(LOG_PATH).size;
    assert.ok(size < 1024, `post-rotation log size ${size} should be tiny`);
    assert.ok(readFileSync(LOG_PATH, 'utf8').includes('post-rotation line'));
    // The rotated file holds the oversized content.
    assert.ok(readFileSync(OLD_PATH, 'utf8').includes('gen-one'));
  });

  it('should keep exactly one rotation (overwrite .old on next rotation)', () => {
    // First rotation.
    seedOversizedLog('gen-one');
    dbgLog('line A');
    assert.ok(existsSync(OLD_PATH));

    // Second rotation — .old must be replaced, not accumulated, so disk
    // usage stays bounded at ~2x the cap.
    seedOversizedLog('gen-two');
    dbgLog('line B');

    const oldContent = readFileSync(OLD_PATH, 'utf8');
    assert.ok(oldContent.includes('gen-two'), '.old should hold the latest rotation');
    assert.ok(!oldContent.includes('gen-one'), 'previous .old must be overwritten');
  });
});
