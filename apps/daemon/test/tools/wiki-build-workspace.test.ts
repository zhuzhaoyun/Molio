import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { makeVault } from './wiki-build-test-helpers.js';

function createDirectoryLink(target: string, path: string, diagnostic: (message: string) => void) {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    diagnostic(`Directory symlinks require unavailable privileges; testing the same reparse-point escape via a junction: ${String(error)}`);
    symlinkSync(target, path, 'junction');
  }
}

const daemonRoot = resolve(import.meta.dirname, '..', '..', '..');
const workspace = await import(pathToFileURL(join(
  daemonRoot,
  'src',
  'tools',
  'skills',
  'wiki-build',
  'scripts',
  'lib',
  'workspace.mjs',
)).href);

describe('wiki-build workspace', () => {
  it('does not write through a workspace symlink that escapes the vault', (t) => {
    const vault = makeVault();
    const outside = makeVault();
    const molio = join(vault.path, '.molio');
    mkdirSync(molio);
    createDirectoryLink(outside.path, join(molio, 'wiki-build'), t.diagnostic.bind(t));

    const paths = workspace.resolveBuildPaths(vault.path);
    assert.throws(
      () => workspace.atomicWriteJson(paths.state, { phase: 'running' }),
      { code: 'PATH_OUTSIDE_VAULT' },
    );
    assert.equal(existsSync(join(outside.path, 'state.json')), false);
    vault.cleanup();
    outside.cleanup();
  });
});
