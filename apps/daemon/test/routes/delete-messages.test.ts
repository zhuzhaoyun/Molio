import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import { conversationRoutes } from '../../src/routes/conversations.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { closeDatabase, openDatabase, upsertMessage, createDesktopConversation, listMessages } from '../../src/core/db.js';
import type { ChatMessage, DeleteMessagesResponse } from '@molio/contracts';

function mkMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('POST /api/conversations/:id/delete-messages', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let conversations: ConversationService;
  let app: Hono;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-dm-'));
    db = openDatabase(join(dir, 'app.sqlite'));
    conversations = new ConversationService(db);
    // RunManager not needed for delete; pass a null-cast mock.
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, null as never, conversations));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function postDelete(convId: string, ids: string[]) {
    const res = await app.request(`/api/conversations/${convId}/delete-messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    return { status: res.status, body: await res.json() as DeleteMessagesResponse & { error?: { code: string } } };
  }

  it('deletes the given ids and returns the count', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('u1', 'user', 'q1'));
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'a1'));
    upsertMessage(db, conv.id, mkMsg('u2', 'user', 'q2'));

    const { status, body } = await postDelete(conv.id, ['u2', 'a1']);
    assert.equal(status, 200);
    assert.equal(body.deleted, 2);
    assert.deepEqual(listMessages(db, conv.id).map((m) => m.id), ['u1']);
  });

  it('silently skips non-existent ids', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('u1', 'user', 'q1'));
    const { status, body } = await postDelete(conv.id, ['u1', 'missing']);
    assert.equal(status, 200);
    assert.equal(body.deleted, 1);
  });

  it('returns 400 on empty ids', async () => {
    const conv = createDesktopConversation(db, 't');
    const { status, body } = await postDelete(conv.id, []);
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'BAD_REQUEST');
  });

  it('returns 404 when conversation does not exist', async () => {
    const { status } = await postDelete('no-such-conv', ['x']);
    assert.equal(status, 404);
  });
});
