import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createProject, createConversation, createVault, createDesktopConversation, upsertMessage } from '../../src/core/db.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { conversationRoutes } from '../../src/routes/conversations.js';
import { Hono } from 'hono';

async function callGet(app: Hono, query: Record<string, string>) {
  const url = 'http://localhost/api/conversations' + (Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '');
  const res = await app.request(url, { method: 'GET' });
  return { status: res.status, body: (await res.json()) as any };
}

describe('GET /api/conversations filters + pagination', () => {
  let app: Hono;
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-conv-route-'));
    db = openDatabase(tempDir);
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, {} as any, new ConversationService(db)));
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns {items, nextCursor} shape', async () => {
    const p = createProject(db, 'P');
    const c = createConversation(db, p.id, 'C');
    upsertMessage(db, c.id, { id: 'r1', role: 'user', content: 'hello', timestamp: Date.now() });
    const { status, body } = await callGet(app, {});
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.items));
    assert.equal(body.nextCursor, null); // single item < limit
  });

  it('filters by query + vaultId together', async () => {
    const v = createVault(db, 'RV', '/tmp/route-v');
    const c1 = createDesktopConversation(db, 'in-vault', v.id);
    const c2 = createDesktopConversation(db, 'other', null);
    upsertMessage(db, c1.id, { id: 'rq1', role: 'user', content: 'shared-token-ZZ', timestamp: Date.now() });
    upsertMessage(db, c2.id, { id: 'rq2', role: 'user', content: 'shared-token-ZZ', timestamp: Date.now() });
    const { body } = await callGet(app, { query: 'shared-token-ZZ', vaultId: v.id });
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].conversation.id, c1.id);
  });

  it('before cursor paginates', async () => {
    const p = createProject(db, 'P2');
    for (let i = 0; i < 3; i++) {
      const c = createConversation(db, p.id, `pg-${i}`);
      upsertMessage(db, c.id, { id: `rp-${i}`, role: 'user', content: `pagetest ${i}`, timestamp: Date.now() + i });
      // Ensure distinct conversation.updated_at values so the cursor is unambiguous.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const first = await callGet(app, { query: 'pagetest', limit: '2' });
    assert.equal(first.body.items.length, 2);
    assert.notEqual(first.body.nextCursor, null);
    const second = await callGet(app, { query: 'pagetest', limit: '2', before: String(first.body.nextCursor) });
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.nextCursor, null);
  });

  it('invalid limit returns 400', async () => {
    const { status } = await callGet(app, { limit: 'abc' });
    assert.equal(status, 400);
  });
});
