import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, openDatabase, upsertMessage, deleteConversation, createDesktopConversation, getRewindPoint, deleteMessagesFromPosition, listMessagesBefore } from '../../src/core/db.js';
import type { ChatMessage } from '@molio/contracts';

function mkMsg(role: 'user' | 'assistant', content: string, runId?: string): ChatMessage {
  return { id: `${role}-${content}`, role, content, timestamp: Date.now(), runId };
}

describe('DB rewind helpers', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-rewind-'));
    db = openDatabase(join(dir, 'app.sqlite'));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  it('getRewindPoint returns last user position + active assistant run id', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-1'));
    upsertMessage(db, conv.id, mkMsg('user', 'q2'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a2', 'run-2'));

    const point = getRewindPoint(db, conv.id);
    assert.equal(point?.position, 2); // q2 is at position 2 (0-indexed auto-increment)
    assert.equal(point?.activeRunId, 'run-2');
  });

  it('getRewindPoint returns null activeRunId when no assistant follows last user', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1', 'run-1'));
    upsertMessage(db, conv.id, mkMsg('user', 'q2')); // no assistant reply yet
    const point = getRewindPoint(db, conv.id);
    assert.equal(point?.position, 2);
    assert.equal(point?.activeRunId, null);
  });

  it('getRewindPoint returns null when conversation has no user message', () => {
    const conv = createDesktopConversation(db, 't');
    assert.equal(getRewindPoint(db, conv.id), null);
  });

  it('deleteMessagesFromPosition removes messages with position >= N', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));     // pos 0
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1')); // pos 1
    upsertMessage(db, conv.id, mkMsg('user', 'q2'));      // pos 2
    upsertMessage(db, conv.id, mkMsg('assistant', 'a2')); // pos 3

    const deleted = deleteMessagesFromPosition(db, conv.id, 2);
    assert.equal(deleted, 2);
    const remaining = listMessagesBefore(db, conv.id, 999); // all remaining
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0]!.content, 'q1');
    assert.equal(remaining[1]!.content, 'a1');
  });

  it('listMessagesBefore returns messages with position < N in order', () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('user', 'q1'));      // pos 0
    upsertMessage(db, conv.id, mkMsg('assistant', 'a1')); // pos 1
    upsertMessage(db, conv.id, mkMsg('user', 'q2'));      // pos 2

    const before = listMessagesBefore(db, conv.id, 2);
    assert.equal(before.length, 2);
    assert.equal(before[0]!.content, 'q1');
    assert.equal(before[1]!.content, 'a1');
  });
});
