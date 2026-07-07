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
import type { ChatMessage } from '@molio/contracts';

function mkMsg(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() };
}

describe('PUT /api/conversations/:id/messages/:msgId', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let conversations: ConversationService;
  let app: Hono;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'molio-umc-'));
    db = openDatabase(join(dir, 'app.sqlite'));
    conversations = new ConversationService(db);
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, null as never, conversations));
  });

  afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
  });

  async function putContent(convId: string, msgId: string, content: string) {
    const res = await app.request(`/api/conversations/${convId}/messages/${msgId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return { status: res.status, body: await res.json() as { ok?: boolean; error?: { code: string } } };
  }

  it('updates content and returns 200', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'old'));
    const { status, body } = await putContent(conv.id, 'a1', 'new text');
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(listMessages(db, conv.id)[0]!.content, 'new text');
  });

  it('returns 404 when msgId not found', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'old'));
    const { status } = await putContent(conv.id, 'no-such', 'x');
    assert.equal(status, 404);
  });

  it('returns 404 when conversation does not exist', async () => {
    const { status } = await putContent('no-such-conv', 'a1', 'x');
    assert.equal(status, 404);
  });

  it('returns 400 on empty content', async () => {
    const conv = createDesktopConversation(db, 't');
    upsertMessage(db, conv.id, mkMsg('a1', 'assistant', 'old'));
    const { status, body } = await putContent(conv.id, 'a1', '   ');
    assert.equal(status, 400);
    assert.equal(body.error?.code, 'BAD_REQUEST');
  });
});
