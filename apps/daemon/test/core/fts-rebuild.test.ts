import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, createProject, createConversation, upsertMessage, rebuildMessagesFts, searchConversationIds } from '../../src/core/db.js';
import type Database from 'better-sqlite3';

describe('rebuildMessagesFts', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-fts-rebuild-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('recovers from emptied fts by repopulating from messages', () => {
    const p = createProject(db, 'P');
    const c = createConversation(db, p.id, 'C');
    upsertMessage(db, c.id, { id: 'rb-m', role: 'user', content: 'rebuild-marker-token', timestamp: Date.now() });
    assert.ok(searchConversationIds(db, 'rebuild-marker-token').includes(c.id));

    // Simulate corruption: wipe fts content.
    db.exec('DELETE FROM messages_fts');
    assert.equal(searchConversationIds(db, 'rebuild-marker-token').length, 0);

    rebuildMessagesFts(db);
    assert.ok(searchConversationIds(db, 'rebuild-marker-token').includes(c.id));
  });
});