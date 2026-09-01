import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { conversationRoutes } from '../../src/routes/conversations.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import {
  closeDatabase, openDatabase, createDesktopConversation, upsertMessage,
  getConversation, listMessages,
} from '../../src/core/db.js';
import type { ChatMessage, BatchDeleteConversationsResponse } from '@molio/contracts';

function mkMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('POST /api/conversations/batch-delete', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let conversations: ConversationService;
  let app: Hono;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-bdel-'));
    db = openDatabase(join(dir, 'app.sqlite'));
    conversations = new ConversationService(db);
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, null as never, conversations));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function postBatch(ids: string[]) {
    const res = await app.request('/api/conversations/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    return { status: res.status, body: await res.json() as BatchDeleteConversationsResponse & { error?: { code: string } } };
  }

  it('deletes multiple conversations and cascades their messages', async () => {
    const c1 = createDesktopConversation(db, 'one');
    const c2 = createDesktopConversation(db, 'two');
    upsertMessage(db, c1.id, mkMsg('u1', 'user', 'q1'));

    const { status, body } = await postBatch([c1.id, c2.id]);
    assert.equal(status, 200);
    assert.equal(body.deleted, 2);
    assert.equal(getConversation(db, c1.id), null);
    assert.equal(getConversation(db, c2.id), null);
    assert.deepEqual(listMessages(db, c1.id), []);
  });

  it('silently skips non-existent ids', async () => {
    const c1 = createDesktopConversation(db, 'one');
    const { status, body } = await postBatch([c1.id, 'missing-id']);
    assert.equal(status, 200);
    assert.equal(body.deleted, 1);
  });

  it('returns 400 on empty ids', async () => {
    const { status, body } = await postBatch([]);
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'BAD_REQUEST');
  });
});
