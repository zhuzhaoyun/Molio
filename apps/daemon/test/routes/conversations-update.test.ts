import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createProject, createConversation } from '../../src/core/db.js';
import { ConversationService } from '../../src/core/conversations/service.js';
import { conversationRoutes } from '../../src/routes/conversations.js';
import { Hono } from 'hono';

async function callPatch(app: Hono, id: string, body: unknown) {
  const res = await app.request(`http://localhost/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe('PATCH /api/conversations/:id', () => {
  let app: Hono;
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-upd-route-'));
    db = openDatabase(tempDir);
    app = new Hono();
    app.route('/api/conversations', conversationRoutes(db, {} as any, new ConversationService(db)));
  });

  after(() => { closeDatabase(); rmSync(tempDir, { recursive: true, force: true }); });

  it('renames title (trimmed) without touching updated_at', async () => {
    const p = createProject(db, 'PU');
    const c = createConversation(db, p.id, 'old-name');
    const { status, body } = await callPatch(app, c.id, { title: '  new-name  ' });
    assert.equal(status, 200);
    assert.equal(body.title, 'new-name');
    assert.equal(body.updatedAt, c.updatedAt);
  });

  it('pins and unpins; GET surfaces pinnedItems', async () => {
    const p = createProject(db, 'PU2');
    const c = createConversation(db, p.id, 'pin-route');
    await callPatch(app, c.id, { pinned: true });
    const pinned = (await (await app.request('http://localhost/api/conversations', { method: 'GET' })).json()) as any;
    assert.equal(pinned.pinnedItems.length, 1);
    assert.equal(pinned.pinnedItems[0].conversation.id, c.id);
    assert.ok(pinned.pinnedItems[0].conversation.pinnedAt != null);
    await callPatch(app, c.id, { pinned: false });
    const after = (await (await app.request('http://localhost/api/conversations', { method: 'GET' })).json()) as any;
    assert.equal(after.pinnedItems.length, 0);
  });

  it('empty title → 400', async () => {
    const p = createProject(db, 'PU3');
    const c = createConversation(db, p.id, 'x');
    const { status } = await callPatch(app, c.id, { title: '   ' });
    assert.equal(status, 400);
  });

  it('missing fields → 400', async () => {
    const p = createProject(db, 'PU4');
    const c = createConversation(db, p.id, 'y');
    const { status } = await callPatch(app, c.id, {});
    assert.equal(status, 400);
  });

  it('unknown id → 404', async () => {
    const { status } = await callPatch(app, 'nope', { title: 'x' });
    assert.equal(status, 404);
  });

  it('invalid JSON → 400', async () => {
    const p = createProject(db, 'PU5');
    const c = createConversation(db, p.id, 'z');
    const res = await app.request(`http://localhost/api/conversations/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  it('title with wrong type → 400', async () => {
    const p = createProject(db, 'PU6');
    const c = createConversation(db, p.id, 'type-title');
    const { status } = await callPatch(app, c.id, { title: 123 });
    assert.equal(status, 400);
  });

  it('pinned with wrong type → 400', async () => {
    const p = createProject(db, 'PU7');
    const c = createConversation(db, p.id, 'type-pinned');
    const { status } = await callPatch(app, c.id, { pinned: 'yes' });
    assert.equal(status, 400);
  });

  it('literal null body → 400', async () => {
    const p = createProject(db, 'PU8');
    const c = createConversation(db, p.id, 'null-body');
    const { status } = await callPatch(app, c.id, null);
    assert.equal(status, 400);
  });
});
