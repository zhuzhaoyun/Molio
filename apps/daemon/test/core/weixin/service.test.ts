import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault } from '../../../src/core/db.js';
import { wikiPromptFileFor } from '../../../src/core/weixin/dispatcher.js';
import { WEIXIN_SYS_PROMPT_FILE } from '../../../src/core/wiki-prompts.js';

/**
 * Tests for wikiPromptFileFor — the single place that decides whether a weixin
 * fresh spawn carries the wiki/vault system-prompt file. The dispatcher calls
 * it only in the fresh-spawn branch (reuse via sendMessage does not), so the
 * "no prompt on follow-up" rule is enforced structurally and covered by the
 * dispatcher tests; here we cover the vault-resolution logic itself.
 */
describe('weixin wikiPromptFileFor', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-weixin-test-'));
    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns the weixin system-prompt file when cwd is a registered vault', () => {
    const vaultPath = join(tempDir, 'vault');
    createVault(db, 'Test Vault', vaultPath);
    assert.equal(wikiPromptFileFor(db, vaultPath), WEIXIN_SYS_PROMPT_FILE);
  });

  it('returns undefined when cwd is not a vault', () => {
    assert.equal(wikiPromptFileFor(db, '/not/a/vault'), undefined);
  });

  it('returns undefined when db or cwd is missing', () => {
    assert.equal(wikiPromptFileFor(undefined, '/some/path'), undefined);
    assert.equal(wikiPromptFileFor(db, undefined), undefined);
  });
});
