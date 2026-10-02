/**
 * Vault root path validation — regression tests for the 2026-09 support
 * incident: a user registered `<vault>\.claude` as a standalone vault
 * (Windows Explorer does not hide dot-prefixed dirs) and the overlapping
 * roots made every stored reference resolve against the wrong root.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateVaultPath, type ExistingVaultRef } from '../../src/core/knowledge.js';

const existing: ExistingVaultRef[] = [
  { id: 'v1', name: 'work', path: join('/home', 'u', 'Molio', 'work') },
];

describe('validateVaultPath — dot-dir roots', () => {
  it('rejects a dot-dir segment (.claude registered as vault root)', () => {
    const issue = validateVaultPath(join('/home', 'u', 'Molio', 'work', '.claude'), existing);
    assert.equal(issue?.code, 'VAULT_PATH_DOT_DIR');
    assert.match(issue!.message, /\.claude/);
  });

  it('rejects Windows-style backslash dot-dir path on any platform', () => {
    const issue = validateVaultPath('D:\\AI\\Molio\\work\\.claude', []);
    assert.equal(issue?.code, 'VAULT_PATH_DOT_DIR');
    assert.match(issue!.message, /\.claude/);
  });

  it('rejects other internal dot-dirs (.molio, .git)', () => {
    assert.equal(validateVaultPath(join('/home', 'u', 'repo', '.git'), [])?.code, 'VAULT_PATH_DOT_DIR');
    assert.equal(validateVaultPath(join('/home', 'u', 'v', '.molio'), [])?.code, 'VAULT_PATH_DOT_DIR');
  });

  it('allows a normal path without dot segments', () => {
    assert.equal(validateVaultPath(join('/home', 'u', 'Molio', 'work001'), existing), null);
  });
});

describe('validateVaultPath — nesting and overlap', () => {
  it('rejects a candidate nested INSIDE an existing vault', () => {
    const issue = validateVaultPath(join('/home', 'u', 'Molio', 'work', 'raw'), existing);
    assert.equal(issue?.code, 'VAULT_PATH_NESTED');
    assert.match(issue!.message, /work/);
  });

  it('rejects a candidate that would CONTAIN an existing vault', () => {
    const issue = validateVaultPath(join('/home', 'u', 'Molio'), existing);
    assert.equal(issue?.code, 'VAULT_PATH_NESTED');
  });

  it('rejects exact duplicate path (trailing separator normalized)', () => {
    const issue = validateVaultPath(join('/home', 'u', 'Molio', 'work') + '/', existing);
    assert.equal(issue?.code, 'VAULT_PATH_EXISTS');
  });

  it('does not false-positive on sibling paths sharing a prefix string', () => {
    // '/home/u/Molio/workx' must NOT trip the prefix check against 'work'
    assert.equal(validateVaultPath(join('/home', 'u', 'Molio', 'workx'), existing), null);
  });

  it('honours excludeVaultId (self-comparison on update flows)', () => {
    assert.equal(
      validateVaultPath(join('/home', 'u', 'Molio', 'work'), existing, { excludeVaultId: 'v1' }),
      null,
    );
  });

  it('flags overlap against a second vault while skipping the excluded one', () => {
    const vaults: ExistingVaultRef[] = [
      ...existing,
      { id: 'v2', name: 'notes', path: join('/home', 'u', 'Molio', 'work', 'notes') },
    ];
    const issue = validateVaultPath(join('/home', 'u', 'Molio', 'work'), vaults, { excludeVaultId: 'v1' });
    assert.equal(issue?.code, 'VAULT_PATH_NESTED');
  });
});
