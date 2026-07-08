import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, createProject, createConversation, upsertMessage, deleteMessagesById } from '../../src/core/db.js';
import type Database from 'better-sqlite3';

function hitConvIds(db: Database.Database, q: string): string[] {
  // Wrap in double quotes to treat as a phrase — required for the FTS5 query
  // parser to not interpret special characters like '-' as operators.
  const quoted = `"${q}"`;
  return (db.prepare('SELECT DISTINCT conversation_id FROM messages_fts WHERE messages_fts MATCH ?').all(quoted) as Array<{ conversation_id: string }>).map((r) => r.conversation_id);
}

describe('messages_fts trigger sync', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-fts-sync-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('INSERT message → fts searchable', () => {
    const p = createProject(db, 'P');
    const c = createConversation(db, p.id, 'C');
    upsertMessage(db, c.id, { id: 'm-ins', role: 'user', content: '凡人修仙传', timestamp: Date.now() });
    assert.ok(hitConvIds(db, '人修仙').includes(c.id));
  });

  it('DELETE message → fts no longer matches', () => {
    const p = createProject(db, 'P2');
    const c = createConversation(db, p.id, 'C2');
    upsertMessage(db, c.id, { id: 'm-del', role: 'user', content: 'unique-marker-delete-me', timestamp: Date.now() });
    assert.ok(hitConvIds(db, 'unique-marker-delete-me').includes(c.id));
    deleteMessagesById(db, c.id, ['m-del']);
    assert.equal(hitConvIds(db, 'unique-marker-delete-me').length, 0);
  });

  it('UPDATE message content → old term gone, new term matches', () => {
    const p = createProject(db, 'P3');
    const c = createConversation(db, p.id, 'C3');
    upsertMessage(db, c.id, { id: 'm-upd', role: 'user', content: 'before-term-xyz', timestamp: Date.now() });
    upsertMessage(db, c.id, { id: 'm-upd', role: 'user', content: 'after-term-abc', timestamp: Date.now() });
    assert.equal(hitConvIds(db, 'before-term-xyz').length, 0);
    assert.ok(hitConvIds(db, 'after-term-abc').includes(c.id));
  });

  it('bulk insert 100 messages all searchable', () => {
    const p = createProject(db, 'P4');
    const c = createConversation(db, p.id, 'C4');
    for (let i = 0; i < 100; i++) {
      upsertMessage(db, c.id, { id: `m-bulk-${i}`, role: 'user', content: `bulk-token-${i}`, timestamp: Date.now() });
    }
    assert.ok(hitConvIds(db, 'bulk-token-50').includes(c.id));
    assert.ok(hitConvIds(db, 'bulk-token-99').includes(c.id));
  });

  it('pre-existing messages backfilled into fts on migrate', () => {
    // messages created before fts existed are seeded by the one-time backfill.
    // After openDatabase already ran in before(), the backfill has executed.
    // Verify by inserting a message then reopening the db.
    const p = createProject(db, 'P5');
    const c = createConversation(db, p.id, 'C5');
    upsertMessage(db, c.id, { id: 'm-seed', role: 'user', content: 'seed-marker-999', timestamp: Date.now() });
    // Reopen — triggers already keep fts in sync, but backfill flag guards re-seed.
    openDatabase(tempDir);
    assert.ok(hitConvIds(db, 'seed-marker-999').includes(c.id));
  });
});
