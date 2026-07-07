import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, upsertMessage, createDesktopConversation, listMessages, deleteMessagesById, updateMessageContent } from '../../src/core/db.js';
import type { ChatMessage } from '@molio/contracts';

function mkMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('DB curation helpers', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-cur-'));
    db = openDatabase(join(dir, 'app.sqlite'));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('deleteMessagesById deletes the given ids and returns the count', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('u1', 'user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'a1'));
    upsertMessage(db, conv.id, mkMsg('u2', 'user', 'q2'));
    upsertMessage(db, conv.id, mkMsg('a2', 'assistant', 'a2'));

    const deleted = deleteMessagesById(db, conv.id, ['u2', 'a2', 'missing-id']);
    assert.equal(deleted, 2);
    const remaining = listMessages(db, conv.id).map((m) => m.id);
    assert.deepEqual(remaining, ['u1', 'a1']);
  });

  it('deleteMessagesById does not cross conversations', () => {
    const c1 = createDesktopConversation(db, 't1');
    const c2 = createDesktopConversation(db, 't2');
    upsertMessage(db, c1.id, mkMsg('u1', 'user', 'q1'));
    upsertMessage(db, c2.id, mkMsg('u2', 'user', 'q2'));

    // Passing c2's id under c1's conversationId must not delete it.
    const deleted = deleteMessagesById(db, c1.id, ['u2']);
    assert.equal(deleted, 0);
    assert.equal(listMessages(db, c2.id).length, 1);
  });

  it('updateMessageContent updates content and returns true on hit', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'old'));
    const ok = updateMessageContent(db, conv.id, 'a1', 'new content');
    assert.equal(ok, true);
    assert.equal(listMessages(db, conv.id)[0]!.content, 'new content');
  });

  it('updateMessageContent returns false when msgId not found', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'old'));
    const ok = updateMessageContent(db, conv.id, 'no-such-id', 'x');
    assert.equal(ok, false);
  });
});
