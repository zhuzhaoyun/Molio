import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase } from '../../src/core/db.js';
import type Database from 'better-sqlite3';

describe('db migration: vault_id + messages_fts', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-migrate-test-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('conversations has vault_id column', () => {
    const cols = db.prepare('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    assert.ok(cols.some((c) => c.name === 'vault_id'));
  });

  it('messages_fts virtual table exists with trigram tokenizer', () => {
    const row = db.prepare("SELECT name, sql FROM sqlite_master WHERE name='messages_fts'").get() as
      | { name: string; sql: string }
      | undefined;
    assert.ok(row, 'messages_fts table should exist');
    assert.match(row!.sql, /trigram/);
  });

  it('migration is idempotent (openDatabase twice does not error)', () => {
    assert.doesNotThrow(() => openDatabase(tempDir));
  });
});
