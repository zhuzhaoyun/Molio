/**
 * Regression tests for logger.js — file-based logging used by the auto-updater.
 *
 * Uses setLogDir(tmpdir) to avoid needing Electron's app.getPath().
 * If any PR breaks the logger, these tests will catch it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { log, getLogPath, setLogDir, _reset } from '../src/logger.js';

let tmpDir;

beforeEach(() => {
  _reset();
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'molio-logger-test-'));
  setLogDir(tmpDir);
});

afterEach(() => {
  _reset();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('log()', () => {
  it('should create log file on first write', () => {
    log('info', 'test', 'hello');
    const logPath = getLogPath();
    assert.ok(existsSync(logPath), 'log file should exist');
  });

  it('should write timestamped lines in correct format', () => {
    log('info', 'updater', 'test message');
    const content = readFileSync(getLogPath(), 'utf-8');
    // Format: [ISO timestamp] [LEVEL] [tag] message
    assert.match(content, /\[\d{4}-\d{2}-\d{2}T.*\] \[INFO\] \[updater\] test message\n/);
  });

  it('should handle all log levels', () => {
    log('info', 't', 'msg1');
    log('warn', 't', 'msg2');
    log('error', 't', 'msg3');
    const content = readFileSync(getLogPath(), 'utf-8');
    assert.match(content, /\[INFO\]/);
    assert.match(content, /\[WARN\]/);
    assert.match(content, /\[ERROR\]/);
  });

  it('should append, not overwrite', () => {
    log('info', 't', 'line1');
    log('info', 't', 'line2');
    log('info', 't', 'line3');
    const content = readFileSync(getLogPath(), 'utf-8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 3);
  });

  it('should not crash on special characters', () => {
    assert.doesNotThrow(() => {
      log('error', 'updater', 'Error: ETIMEDOUT (connection refused)');
      log('error', 'updater', 'message with "quotes" and {braces}');
      log('error', 'updater', 'multiline\nmessage');
    });
    const content = readFileSync(getLogPath(), 'utf-8');
    assert.ok(content.includes('ETIMEDOUT'));
  });
});

describe('getLogPath()', () => {
  it('should return a path inside the configured log directory', () => {
    const logPath = getLogPath();
    assert.ok(logPath.startsWith(tmpDir), `log path ${logPath} should be inside ${tmpDir}`);
    assert.ok(logPath.endsWith('updater.log'));
  });
});

describe('log rotation', () => {
  it('should rotate log file when it exceeds 1MB', () => {
    // Write a large file to simulate an oversized log
    const logPath = path.join(tmpDir, 'updater.log');
    const bigContent = 'x'.repeat(1024 * 1024 + 100); // > 1MB
    writeFileSync(logPath, bigContent);

    // Reset to trigger ensureLogPath again
    _reset();
    setLogDir(tmpDir);

    // Writing a new log entry should trigger rotation
    log('info', 'test', 'after rotation');

    // Old file should be rotated to .old
    assert.ok(existsSync(logPath + '.old'), 'rotated .old file should exist');

    // New file should only have the new entry
    const newContent = readFileSync(logPath, 'utf-8');
    assert.ok(newContent.includes('after rotation'));
    assert.ok(!newContent.includes('xxxxx'), 'new file should not contain old content');
  });

  it('should rotate within a long session, not only at startup', () => {
    // Regression: rotation used to run once in ensureLogPath at first use, so
    // a session running for a day (heavy daemon stderr forwarding) grew the
    // log file without bound. log() must rotate mid-session past 1MB.
    const logPath = path.join(tmpDir, 'updater.log');
    const payload = 'y'.repeat(1000);
    // ~1200 lines × ~1060 bytes ≈ 1.24MB → comfortably past the 1MB cap.
    for (let i = 0; i < 1200; i++) {
      log('info', 'daemon', `line ${i} ${payload}`);
    }

    assert.ok(existsSync(logPath + '.old'), 'mid-session rotation should produce .old');
    const size = statSync(logPath).size;
    assert.ok(size < 1024 * 1024, `live log (${size} bytes) should be back under the cap`);
  });
});

describe('setLogDir()', () => {
  it('should allow overriding the log directory', () => {
    const customDir = mkdtempSync(path.join(os.tmpdir(), 'molio-custom-log-'));
    _reset();
    setLogDir(customDir);

    log('info', 'test', 'custom dir');
    const logPath = getLogPath();
    assert.ok(logPath.startsWith(customDir));

    _reset();
    rmSync(customDir, { recursive: true, force: true });
  });
});
