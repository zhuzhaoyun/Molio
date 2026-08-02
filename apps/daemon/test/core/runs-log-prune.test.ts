import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pruneRunLogs } from '../../src/core/runs-log-prune.js';

/**
 * Regression test: per-run JSONL logs (~/.molio/runs/<runId>/) were never
 * deleted — ~2000 directories / 72MB accumulated on a real machine in five
 * weeks. pruneRunLogs must remove directories older than the retention
 * window and leave recent ones alone.
 */

let tmpDir: string;
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'molio-runs-prune-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fake run log dir with a controlled mtime (days ago). */
function makeRunDir(name: string, ageDays: number, now: number): string {
  const dir = path.join(tmpDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'events.jsonl'), '{"id":1}\n');
  const mtime = new Date(now - ageDays * DAY_MS);
  utimesSync(dir, mtime, mtime);
  return dir;
}

describe('pruneRunLogs', () => {
  it('should remove directories older than the retention window', () => {
    const now = Date.now();
    const old = makeRunDir('run-old', 10, now);
    const recent = makeRunDir('run-recent', 2, now);

    const result = pruneRunLogs({ dir: tmpDir, now });

    assert.equal(result.removed, 1);
    assert.equal(result.kept, 1);
    assert.equal(existsSync(old), false, 'old run dir should be deleted');
    assert.ok(existsSync(recent), 'recent run dir should survive');
    assert.ok(existsSync(path.join(recent, 'events.jsonl')));
  });

  it('should delete the whole run directory tree, not just the top level', () => {
    const now = Date.now();
    const old = makeRunDir('run-nested', 30, now);
    mkdirSync(path.join(old, 'sub'));
    writeFileSync(path.join(old, 'sub', 'extra.jsonl'), '{}\n');
    // Re-apply the aged mtime after adding children (child creation bumps it).
    const mtime = new Date(now - 30 * DAY_MS);
    utimesSync(old, mtime, mtime);

    const result = pruneRunLogs({ dir: tmpDir, now });

    assert.equal(result.removed, 1);
    assert.equal(existsSync(old), false);
  });

  it('should keep directories exactly at the age boundary', () => {
    const now = Date.now();
    // mtime exactly maxAgeDays ago → age == maxAgeMs → NOT strictly older → kept.
    const boundary = makeRunDir('run-boundary', 7, now);

    const result = pruneRunLogs({ dir: tmpDir, maxAgeDays: 7, now });

    assert.equal(result.removed, 0);
    assert.equal(result.kept, 1);
    assert.ok(existsSync(boundary));
  });

  it('should respect a custom maxAgeDays', () => {
    const now = Date.now();
    const twoDaysOld = makeRunDir('run-2d', 2, now);

    const result = pruneRunLogs({ dir: tmpDir, maxAgeDays: 1, now });

    assert.equal(result.removed, 1);
    assert.equal(existsSync(twoDaysOld), false);
  });

  it('should skip loose files and only prune directories', () => {
    const now = Date.now();
    const looseFile = path.join(tmpDir, 'stray.jsonl');
    writeFileSync(looseFile, '{}');
    const old = new Date(now - 30 * DAY_MS);
    utimesSync(looseFile, old, old);
    makeRunDir('run-old', 30, now);

    const result = pruneRunLogs({ dir: tmpDir, now });

    assert.equal(result.removed, 1);
    assert.ok(existsSync(looseFile), 'loose files must not be touched');
  });

  it('should tolerate a missing directory (fresh install)', () => {
    const result = pruneRunLogs({ dir: path.join(tmpDir, 'does-not-exist') });
    assert.deepEqual(result, { removed: 0, failed: 0, kept: 0 });
  });

  it('should keep sweeping when one entry fails', () => {
    const now = Date.now();
    makeRunDir('run-a', 20, now);
    // A dangling symlink makes statSync throw — the sweep must count it as
    // failed and continue to the next entry instead of aborting.
    const dangling = path.join(tmpDir, 'dangling');
    try {
      // Skip gracefully if the platform forbids symlink creation
      // (unprivileged Windows).
      symlinkSync(path.join(tmpDir, 'no-such-target'), dangling);
    } catch {
      // Symlinks unavailable — the rest of the test still covers the sweep.
    }
    makeRunDir('run-b', 20, now);

    const result = pruneRunLogs({ dir: tmpDir, now });

    assert.equal(result.removed, 2, 'both aged run dirs should be removed');
    assert.ok(existsSync(path.join(tmpDir, 'run-a')) === false);
    assert.ok(existsSync(path.join(tmpDir, 'run-b')) === false);
  });
});
