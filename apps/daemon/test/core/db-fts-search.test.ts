import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, createProject, createConversation, upsertMessage, searchConversationIds } from '../../src/core/db.js';
import type Database from 'better-sqlite3';

describe('searchConversationIds', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-fts-search-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('chinese substring matches', () => {
    const p = createProject(db, 'P');
    const c = createConversation(db, p.id, 'C');
    upsertMessage(db, c.id, { id: 'm1', role: 'user', content: '凡人修仙传是一本小说', timestamp: Date.now() });
    assert.ok(searchConversationIds(db, '凡人修').includes(c.id));
  });

  it('2-char chinese query matches via LIKE fallback (trigram needs >=3)', () => {
    const p = createProject(db, 'P-short');
    const c = createConversation(db, p.id, 'C-short');
    upsertMessage(db, c.id, { id: 'm-short', role: 'user', content: '凡人修仙传是一本小说', timestamp: Date.now() });
    // "修仙" is 2 chars — trigram cannot match, LIKE fallback must.
    assert.ok(searchConversationIds(db, '修仙').includes(c.id));
  });

  it('2-char query with LIKE wildcard chars is escaped', () => {
    const p = createProject(db, 'P-wild');
    const c = createConversation(db, p.id, 'C-wild');
    upsertMessage(db, c.id, { id: 'm-wild', role: 'user', content: 'a%b_c', timestamp: Date.now() });
    // "%" and "_" are literal in content; a 2-char query containing them must
    // not be treated as wildcards.
    assert.ok(searchConversationIds(db, '%b').includes(c.id));
  });

  it('case-insensitive', () => {
    const p = createProject(db, 'P2');
    const c = createConversation(db, p.id, 'C2');
    upsertMessage(db, c.id, { id: 'm2', role: 'user', content: 'Hello World', timestamp: Date.now() });
    assert.ok(searchConversationIds(db, 'hello').includes(c.id));
  });

  it('special FTS5 chars treated as literal substring', () => {
    const p = createProject(db, 'P3');
    const c = createConversation(db, p.id, 'C3');
    upsertMessage(db, c.id, { id: 'm3', role: 'user', content: 'a:b"c*d', timestamp: Date.now() });
    // Should not throw FTS5 syntax error; should match the literal content.
    assert.ok(searchConversationIds(db, 'a:b"c*d').includes(c.id));
  });

  it('query longer than 200 chars is truncated, still matches', () => {
    const p = createProject(db, 'P4');
    const c = createConversation(db, p.id, 'C4');
    const needle = 'needle-in-haystack';
    // Message content must contain the truncated query — phrase search requires
    // the entire 200-char query to appear verbatim in the document.
    upsertMessage(db, c.id, { id: 'm4', role: 'user', content: needle + 'x'.repeat(200), timestamp: Date.now() });
    const long = needle + 'x'.repeat(300);
    assert.ok(searchConversationIds(db, long).includes(c.id));
  });

  it('empty/whitespace query returns [] without hitting FTS', () => {
    assert.deepEqual(searchConversationIds(db, ''), []);
    assert.deepEqual(searchConversationIds(db, '   '), []);
  });

  it('zero hits returns []', () => {
    assert.deepEqual(searchConversationIds(db, 'no-such-term-exists-xyzzy'), []);
  });
});