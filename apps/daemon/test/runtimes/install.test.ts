import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { InstallEvent } from '@molio/contracts';
import { installAgent, getMolioBinDir, extractFromTarball, addToUserPath, updateCurrentProcessPath, getPlatformKey } from '../../src/core/runtimes/install.js';

// ─── Platform Detection ───────────────────────────────────────────────────

describe('getPlatformKey', () => {
  it('should return a valid platform key string', () => {
    const key = getPlatformKey();
    assert.ok(typeof key === 'string' && key.length > 0);
    // Should be in the form "platform-arch" or "linux-arch-musl"
    const parts = key.split('-');
    assert.ok(parts.length >= 2, `platform key "${key}" should have at least 2 parts`);
    assert.ok(['win32', 'darwin', 'linux'].includes(parts[0]!),
      `platform should be one of win32/darwin/linux, got: ${parts[0]}`);
  });
});

// ─── getMolioBinDir ────────────────────────────────────────────────────────

describe('getMolioBinDir', () => {
  it('should return a path inside ~/.molio/bin', () => {
    const binDir = getMolioBinDir();
    const home = os.homedir();
    assert.ok(binDir.startsWith(home), `binDir ${binDir} should be inside home directory ${home}`);
    assert.ok(binDir.includes('.molio'), 'binDir should be inside .molio directory');
    assert.ok(binDir.endsWith('bin'), 'binDir should end with "bin"');
  });
});

// ─── installAgent ──────────────────────────────────────────────────────────

describe('installAgent', () => {
  it('should emit structured error for unknown agent', async () => {
    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'nonexistent-agent',
      onEvent: (event) => events.push(event),
    });

    assert.ok(events.length > 0, 'should emit at least one event');
    const lastEvent = events[events.length - 1]!;
    assert.equal(lastEvent.type, 'error');
    if (lastEvent.type === 'error') {
      assert.match(lastEvent.message, /No install configuration found/);
      assert.equal(lastEvent.category, 'unknown');
      assert.equal(lastEvent.retryable, false);
      assert.ok(lastEvent.hint, 'error should include a hint for manual install');
    }
  });

  it('should support AbortSignal cancellation', async () => {
    const ac = new AbortController();
    ac.abort(); // Abort immediately

    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'claude',
      signal: ac.signal,
      onEvent: (event) => events.push(event),
    });

    // Should emit an error event about cancellation or never start downloading
    // The preflight phase may run before the abort checkpoint, so we just verify
    // no 'done' event was emitted.
    const doneEvents = events.filter(e => e.type === 'done');
    assert.equal(doneEvents.length, 0, 'should not emit done when aborted');
  });
});

/**
 * Error-driven test for Windows version check during install.
 *
 * Bug: On Windows 10 1607 (build 14393) / Server 2016, the Claude Code native
 * binary fails with STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139).
 * Fix: Check Windows build number before downloading; reject with a clear
 * error message including category='platform' and retryable=false.
 */
describe('Windows version check (error-driven)', () => {
  it('should reject install on Windows builds older than 17763', async () => {
    if (process.platform !== 'win32') return;

    const release = os.release();
    const parts = release.split('.');
    const build = parseInt(parts[parts.length - 1] || '', 10);

    if (build >= 17763) return; // Skip on modern Windows

    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'claude',
      onEvent: (event) => events.push(event),
    });

    const lastEvent = events[events.length - 1];
    assert.equal(lastEvent?.type, 'error', 'should fail on old Windows');
    if (lastEvent?.type === 'error') {
      assert.match(lastEvent.message, /Windows version too old|build/i);
      assert.match(lastEvent.message, /17763/);
      assert.equal(lastEvent.category, 'platform');
      assert.equal(lastEvent.retryable, false);
      assert.ok(lastEvent.hint, 'should include hint for manual install');
    }
  });
});

// ─── Tarball Extraction ────────────────────────────────────────────────────

describe('tarball extraction', () => {
  it('should extract file from a simple tarball', () => {
    const content = Buffer.from('fake-binary-content');
    const header = Buffer.alloc(512);

    header.write('package/claude.exe', 0, 100, 'utf8');
    header.write('100755 ', 100, 8, 'utf8');
    header.write('00000000', 108, 8, 'utf8');
    header.write('00000000', 116, 8, 'utf8');
    header.write(content.length.toString(8).padStart(11, '0') + ' ', 124, 12, 'utf8');
    header.write('00000000000 ', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\x0000', 257, 8, 'utf8');

    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      if (i >= 148 && i < 156) {
        checksum += 32;
      } else {
        checksum += header[i] ?? 0;
      }
    }
    header.write(checksum.toString(8).padStart(6, '0') + ' \0', 148, 8, 'utf8');

    const paddingSize = content.length % 512 === 0 ? 0 : 512 - (content.length % 512);
    const padding = Buffer.alloc(paddingSize);
    const tarBuffer = Buffer.concat([header, content, padding]);
    const gzipped = gzipSync(tarBuffer);

    const extracted = extractFromTarball(gzipped, 'package/claude.exe');
    assert.ok(extracted, 'should extract the file');
    assert.equal(extracted?.toString(), 'fake-binary-content');
  });

  it('should return null when file is not in tarball', () => {
    const header = Buffer.alloc(512);
    header.write('package/other.exe', 0, 100, 'utf8');
    header.write('00000000000 ', 124, 12, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\x0000', 257, 8, 'utf8');

    const gzipped = gzipSync(header);
    const extracted = extractFromTarball(gzipped, 'package/claude.exe');
    assert.equal(extracted, null);
  });
});

// ─── PATH Management ──────────────────────────────────────────────────────

describe('PATH update after install (error-driven)', () => {
  it('addToUserPath should be a function', () => {
    assert.equal(typeof addToUserPath, 'function');
  });

  it('updateCurrentProcessPath should add dir to process PATH', () => {
    const tmpDir = path.join(os.tmpdir(), `molio-proc-${Date.now()}`);
    const pathKey = Object.keys(process.env).find(
      (k) => k.toUpperCase() === 'PATH',
    ) || 'PATH';
    const savedPath = process.env[pathKey];

    try {
      updateCurrentProcessPath(tmpDir);
      const pathAfter = process.env[pathKey] || '';
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const normDir = tmpDir.replace(/[\\/]+$/, '').toLowerCase();
      const isPresent = pathAfter.split(pathSep).some(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      );
      assert.ok(isPresent, `process PATH should contain ${tmpDir}`);
    } finally {
      process.env[pathKey] = savedPath;
    }
  });

  it('updateCurrentProcessPath should not duplicate when called twice', () => {
    const tmpDir = path.join(os.tmpdir(), `molio-dup-${Date.now()}`);
    const pathKey = Object.keys(process.env).find(
      (k) => k.toUpperCase() === 'PATH',
    ) || 'PATH';
    const savedPath = process.env[pathKey];

    try {
      const pathSep = process.platform === 'win32' ? ';' : ':';
      const normDir = tmpDir.replace(/[\\/]+$/, '').toLowerCase();

      updateCurrentProcessPath(tmpDir);
      const count1 = (process.env[pathKey] || '').split(pathSep).filter(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      ).length;

      updateCurrentProcessPath(tmpDir);
      const count2 = (process.env[pathKey] || '').split(pathSep).filter(
        (d) => d.replace(/[\\/]+$/, '').toLowerCase() === normDir,
      ).length;

      assert.equal(count2, count1, 'should not duplicate');
    } finally {
      process.env[pathKey] = savedPath;
    }
  });
});
