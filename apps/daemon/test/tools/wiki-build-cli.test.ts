import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeVault, runWikiBuildCli } from './wiki-build-test-helpers.js';

function createDirectoryLink(target: string, path: string, diagnostic: (message: string) => void) {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    diagnostic(`Directory symlinks require unavailable privileges; testing the same reparse-point escape via a junction: ${String(error)}`);
    symlinkSync(target, path, 'junction');
  }
}

describe('wiki-build CLI', () => {
  it('reports not_started without creating wiki/', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['status', '--json']);
    assert.equal(result.status, 0);
    assert.deepEqual(result.json, {
      ok: true,
      command: 'status',
      data: { phase: 'not_started' },
    });
    assert.equal(existsSync(join(vault.path, 'wiki')), false);
    vault.cleanup();
  });

  it('rejects relative paths escaping the vault', () => {
    const vault = makeVault();
    const result = runWikiBuildCli(vault.path, ['scan', '--include', '../outside.md', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
  });

  it('rejects an absolute include path outside the vault', () => {
    const vault = makeVault();
    const outside = makeVault();
    const result = runWikiBuildCli(vault.path, ['scan', '--include', join(outside.path, 'outside.md'), '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
    outside.cleanup();
  });

  it('rejects an include that follows a vault symlink outside', (t) => {
    const vault = makeVault();
    const outside = makeVault();
    writeFileSync(join(outside.path, 'outside.md'), 'outside');
    createDirectoryLink(outside.path, join(vault.path, 'linked-outside'), t.diagnostic.bind(t));

    const result = runWikiBuildCli(vault.path, ['scan', '--include', 'linked-outside/outside.md', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
    outside.cleanup();
  });

  it('rejects a missing include below a vault symlink that points outside', (t) => {
    const vault = makeVault();
    const outside = makeVault();
    createDirectoryLink(outside.path, join(vault.path, 'linked-outside'), t.diagnostic.bind(t));

    const result = runWikiBuildCli(vault.path, ['scan', '--include', 'linked-outside/new.md', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.json.error.code, 'PATH_OUTSIDE_VAULT');
    vault.cleanup();
    outside.cleanup();
  });
});
