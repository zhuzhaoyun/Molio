import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { installAgent, analyzeNpmError } from '../../src/core/runtimes/install.js';
import type { InstallEvent } from '@molio/contracts';

/**
 * Tests for the agent installation module.
 * Covers error analysis, event flow, and unsupported agent handling.
 */

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

describe('installAgent', () => {
  it('should emit error for unknown agent', async () => {
    const events: InstallEvent[] = [];
    await installAgent({
      agentId: 'nonexistent-agent',
      onEvent: (event) => events.push(event),
    });

    assert.ok(events.length > 0, 'should emit at least one event');
    const lastEvent = events[events.length - 1];
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
    assert.match(nodeCheckEvents[0].message, /Node\.js/);
  });
});
