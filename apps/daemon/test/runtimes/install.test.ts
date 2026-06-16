import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installAgent, analyzeNpmError, getUserNpmPrefix, readLatestNpmLog, parseNodeVersion, isNodeVersionCompatible, createNodeShim } from '../../src/core/runtimes/install.js';
import type { InstallEvent } from '@molio/contracts';

/**
 * Tests for the agent installation module.
 * Covers error analysis, event flow, and unsupported agent handling.
 */

describe('parseNodeVersion', () => {
  it('should parse v18.17.0', () => {
    assert.deepEqual(parseNodeVersion('v18.17.0'), [18, 17, 0]);
  });

  it('should parse v14.21.3', () => {
    assert.deepEqual(parseNodeVersion('v14.21.3'), [14, 21, 3]);
  });

  it('should parse without v prefix', () => {
    assert.deepEqual(parseNodeVersion('20.5.0'), [20, 5, 0]);
  });

  it('should return null for invalid input', () => {
    assert.equal(parseNodeVersion('not-a-version'), null);
  });
});

describe('isNodeVersionCompatible', () => {
  it('should accept v18.17.0', () => {
    assert.equal(isNodeVersionCompatible('v18.17.0'), true);
  });

  it('should accept v20.5.0', () => {
    assert.equal(isNodeVersionCompatible('v20.5.0'), true);
  });

  it('should accept v24.11.1 (Electron embedded)', () => {
    assert.equal(isNodeVersionCompatible('v24.11.1'), true);
  });

  it('should reject v14.21.3', () => {
    assert.equal(isNodeVersionCompatible('v14.21.3'), false);
  });

  it('should reject v16.20.0', () => {
    assert.equal(isNodeVersionCompatible('v16.20.0'), false);
  });

  it('should reject v18.16.0 (just below minimum)', () => {
    assert.equal(isNodeVersionCompatible('v18.16.0'), false);
  });

  it('should reject v20.4.0 (just below minimum)', () => {
    assert.equal(isNodeVersionCompatible('v20.4.0'), false);
  });

  it('should return false for invalid input', () => {
    assert.equal(isNodeVersionCompatible('garbage'), false);
  });
});

describe('analyzeNpmError', () => {
  it('should detect network errors (ECONNREFUSED)', () => {
    const result = analyzeNpmError('npm ERR! code ECONNREFUSED\nnpm ERR! errno ECONNREFUSED');
    assert.equal(result.type, 'network');
  });

  it('should detect network errors (ETIMEDOUT)', () => {
    const result = analyzeNpmError('npm ERR! network request to https://registry.npmjs.org failed, reason: ETIMEDOUT');
    assert.equal(result.type, 'network');
  });

  it('should detect network errors (fetchError)', () => {
    const result = analyzeNpmError('npm ERR! FetchError: request to https://registry.npmjs.org/@anthropic-ai/claude-code failed');
    assert.equal(result.type, 'network');
  });

  it('should detect network errors (getaddrinfo)', () => {
    const result = analyzeNpmError('npm ERR! getaddrinfo ENOTFOUND registry.npmjs.org');
    assert.equal(result.type, 'network');
  });

  it('should detect permission errors (EACCES)', () => {
    const result = analyzeNpmError('npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! Error: EACCES: permission denied');
    assert.equal(result.type, 'permission');
  });

  it('should detect permission errors (permission denied)', () => {
    const result = analyzeNpmError('npm ERR! Error: EACCES: permission denied, access \'/usr/lib/node_modules\'');
    assert.equal(result.type, 'permission');
  });

  it('should detect conflict errors (EEXIST)', () => {
    const result = analyzeNpmError('npm ERR! code EEXIST\nnpm ERR! path /usr/local/bin/claude');
    assert.equal(result.type, 'conflict');
  });

  it('should detect conflict errors (dest already exists)', () => {
    const result = analyzeNpmError('npm ERR! dest already exists.');
    assert.equal(result.type, 'conflict');
  });

  it('should detect Windows EPERM permission errors', () => {
    const result = analyzeNpmError(
      'npm ERR! code EPERM\nnpm ERR! syscall mkdir\nnpm ERR! path C:\\Users\\test\\AppData\\Roaming\\npm\\node_modules'
    );
    assert.equal(result.type, 'permission');
  });

  it('should detect Windows "access is denied" errors', () => {
    const result = analyzeNpmError('npm ERR! Error: access is denied, open \'C:\\Program Files\\nodejs\\node_modules\'');
    assert.equal(result.type, 'permission');
  });

  it('should show first lines of error (not stack trace tail) for unknown errors', () => {
    const stderr = 'npm ERR! code E404\nnpm ERR! 404 Not Found: nonexistent-pkg\n' +
      'npm ERR!     at throwIt (node:internal:1:1)\n' +
      'npm ERR!     at doThing (node:internal:2:2)\n' +
      'npm ERR!     at moreStack (node:internal:3:3)\n' +
      'npm ERR!     at bottomOfStack (node:internal:4:4)';
    const result = analyzeNpmError(stderr);
    assert.equal(result.type, 'unknown');
    // The detail should include the first lines where the actual error is
    assert.ok(result.detail!.includes('E404'), 'detail should include the error code from the first lines');
  });

  it('should return unknown for unrecognized errors', () => {
    const result = analyzeNpmError('npm ERR! code E404\nnpm ERR! 404 Not Found: nonexistent-pkg');
    assert.equal(result.type, 'unknown');
    assert.ok(result.detail);
  });

  it('should return unknown for empty stderr', () => {
    const result = analyzeNpmError('');
    assert.equal(result.type, 'unknown');
  });
});

describe('getUserNpmPrefix', () => {
  it('should return a path inside user home directory', () => {
    const prefix = getUserNpmPrefix();
    const home = os.homedir();
    assert.ok(
      prefix.startsWith(home),
      `prefix ${prefix} should be inside home directory ${home}`
    );
    assert.ok(
      prefix.includes('.molio'),
      'prefix should be inside .molio directory'
    );
  });
});

describe('readLatestNpmLog', () => {
  it('should not throw when npm log directory does not exist', () => {
    // readLatestNpmLog should gracefully return null when ~/.npm/_logs/ doesn't exist
    // or return a string if logs are present. Either way, it should not throw.
    const result = readLatestNpmLog();
    assert.ok(
      result === null || typeof result === 'string',
      'readLatestNpmLog should return null or string, never throw'
    );
  });
});

describe('installAgent', () => {
  it('should emit error for unknown agent', async () => {
    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'nonexistent-agent',
      onEvent: (event) => events.push(event),
    });

    assert.ok(events.length > 0, 'should emit at least one event');
    const lastEvent = events[events.length - 1]!;
    assert.equal(lastEvent.type, 'error');
    assert.match(lastEvent.message, /No install package configured/);
  });

  it('should emit node-check event for claude agent', async () => {
    const events: InstallEvent[] = [];

    // We can't easily test the full install without actually running npm,
    // but we can verify that node-check events are emitted.
    // The install will either succeed (done) or fail with a specific error.
    await installAgent({
      agentId: 'claude',
      onEvent: (event) => events.push(event),
    });

    // First event should be node-check
    const nodeCheckEvents = events.filter(e => e.type === 'node-check');
    assert.ok(nodeCheckEvents.length > 0, 'should emit at least one node-check event');
    assert.match(nodeCheckEvents[0]!.message, /Node\.js/);
  });
});

describe('createNodeShim', () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    // Clean up any shim directories created during tests
    for (const dir of createdDirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    createdDirs.length = 0;
  });

  it('should create a node.cmd wrapper in a temp directory', () => {
    const fakeNode = process.platform === 'win32'
      ? 'C:\\Program Files\\TestApp\\electron.exe'
      : '/usr/local/bin/electron';
    const shimDir = createNodeShim(fakeNode);
    createdDirs.push(shimDir);

    // Directory should exist
    assert.ok(fs.existsSync(shimDir), `shim directory should exist: ${shimDir}`);

    // node.cmd should exist
    const nodeCmd = path.join(shimDir, 'node.cmd');
    assert.ok(fs.existsSync(nodeCmd), `node.cmd should exist: ${nodeCmd}`);

    // Content should set ELECTRON_RUN_AS_NODE and invoke the binary
    const content = fs.readFileSync(nodeCmd, 'utf8');
    assert.ok(content.includes('ELECTRON_RUN_AS_NODE=1'), 'should set ELECTRON_RUN_AS_NODE=1');
    assert.ok(content.includes(fakeNode), `should reference the binary: ${fakeNode}`);
    assert.ok(content.includes('%*'), 'should forward arguments with %*');
    assert.ok(content.includes('@echo off'), 'should suppress command echo');
  });

  it('should be in the system temp directory', () => {
    const fakeNode = process.platform === 'win32' ? 'C:\\test\\node.exe' : '/tmp/node';
    const shimDir = createNodeShim(fakeNode);
    createdDirs.push(shimDir);

    assert.ok(
      shimDir.startsWith(os.tmpdir()),
      `shim dir ${shimDir} should be inside temp directory ${os.tmpdir()}`
    );
  });

  it('should be idempotent (calling twice does not fail)', () => {
    const fakeNode = process.platform === 'win32' ? 'C:\\test\\node.exe' : '/tmp/node';
    const shimDir1 = createNodeShim(fakeNode);
    createdDirs.push(shimDir1);
    const shimDir2 = createNodeShim(fakeNode);
    // Should be the same directory (molio-node-shim)
    assert.equal(shimDir1, shimDir2);
  });
});
