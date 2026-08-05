import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase, closeDatabase, createDesktopConversation, updateConversation,
} from '../../src/core/db.js';

describe('updateConversation', () => {
  let dir: string;

  before(() => { dir = mkdtempSync(join(tmpdir(), 'molio-upd-')); openDatabase(dir); });
  after(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  it('renames title and does NOT bump updated_at', () => {
    const db = openDatabase(dir);
    const c = createDesktopConversation(db, 'old');
    const beforeUpd = c.updatedAt;
    const renamed = updateConversation(db, c.id, { title: '  new title  ' });
    assert.ok(renamed);
    assert.equal(renamed.title, 'new title'); // trimmed
    assert.equal(renamed.updatedAt, beforeUpd); // NOT bumped
    assert.equal(renamed.createdAt, c.createdAt);
  });

  it('rejects empty/whitespace title', () => {
    const db = openDatabase(dir);
    const c = createDesktopConversation(db, 'keep');
    assert.throws(() => updateConversation(db, c.id, { title: '   ' }), /non-empty/);
    assert.equal(updateConversation(db, c.id, {})!.title, 'keep');
  });

  it('pin sets pinnedAt; unpin clears it; other fields untouched', () => {
    const db = openDatabase(dir);
    const c = createDesktopConversation(db, 'pin-me');
    const pinned = updateConversation(db, c.id, { pinned: true });
    assert.ok(pinned);
    assert.ok(pinned.pinnedAt != null && pinned.pinnedAt > 0);
    assert.equal(pinned.title, 'pin-me');
    const unpinned = updateConversation(db, c.id, { pinned: false });
    assert.ok(unpinned);
    assert.equal(unpinned.pinnedAt, null);
  });

  it('returns null for unknown id', () => {
    const db = openDatabase(dir);
    assert.equal(updateConversation(db, 'no-such-id', { pinned: true }), null);
  });
});
