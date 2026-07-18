import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeVault, runWikiBuildCli } from './wiki-build-test-helpers.js';

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
});
