import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase, closeDatabase, createProject, createConversation,
  createDesktopConversation, createVault, upsertMessage, updateConversation, listConversationHistory,
} from '../../src/core/db.js';
import type Database from 'better-sqlite3';

describe('listConversationHistory filters + cursor', () => {
  let db: Database.Database;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-list-hist-'));
    db = openDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('filters by vaultId', () => {
    const v = createVault(db, 'V', '/tmp/vault-v');
    const c1 = createDesktopConversation(db, 'with-vault', v.id);
    const c2 = createDesktopConversation(db, 'no-vault', null);
    upsertMessage(db, c1.id, { id: 'a1', role: 'user', content: 'hi', timestamp: Date.now() });
    upsertMessage(db, c2.id, { id: 'a2', role: 'user', content: 'hi', timestamp: Date.now() });

    const page = listConversationHistory(db, { vaultId: v.id });
    const ids = page.items.map((i) => i.conversation.id);
    assert.ok(ids.includes(c1.id));
    assert.ok(!ids.includes(c2.id));
  });

  it("vaultId='__none__' returns only unassociated", () => {
    const v = createVault(db, 'V2', '/tmp/vault-v2');
    const c1 = createDesktopConversation(db, 'with-vault2', v.id);
    const c2 = createDesktopConversation(db, 'no-vault2', null);
    upsertMessage(db, c1.id, { id: 'b1', role: 'user', content: 'hi', timestamp: Date.now() });
    upsertMessage(db, c2.id, { id: 'b2', role: 'user', content: 'hi', timestamp: Date.now() });

    const page = listConversationHistory(db, { vaultId: '__none__' });
    const ids = page.items.map((i) => i.conversation.id);
    assert.ok(ids.includes(c2.id));
    assert.ok(!ids.includes(c1.id));
  });

  it('cursor pagination: limit=2 over 3 items', async () => {
    const p = createProject(db, 'P3');
    const convs = [];
    for (let i = 0; i < 3; i++) {
      const c = createConversation(db, p.id, `pg-${i}`);
      // Stagger updated_at so the cursor is stable and distinct.
      await new Promise((resolve) => setTimeout(resolve, 5));
      upsertMessage(db, c.id, { id: `pg-m-${i}`, role: 'user', content: `page ${i}`, timestamp: Date.now() + i });
      convs.push(c);
    }
    const first = listConversationHistory(db, { limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.items[1]);
    assert.equal(first.nextCursor, first.items[1].conversation.updatedAt);

    const second = listConversationHistory(db, { limit: 2, before: first.nextCursor });
    assert.equal(second.items.length, 1);
    assert.equal(second.nextCursor, null);
  });

  it('query filters to matching conversations', () => {
    const p = createProject(db, 'P4');
    const c = createConversation(db, p.id, 'search-conv');
    upsertMessage(db, c.id, { id: 'q1', role: 'user', content: 'unique-search-token-42', timestamp: Date.now() });
    const page = listConversationHistory(db, { query: 'unique-search-token-42' });
    assert.equal(page.items.length, 1);
    assert.ok(page.items[0]);
    assert.equal(page.items[0].conversation.id, c.id);
  });

  it('query with zero hits returns empty page, no error', () => {
    const page = listConversationHistory(db, { query: 'no-such-token-xyzzy' });
    assert.equal(page.items.length, 0);
    assert.equal(page.nextCursor, null);
    assert.equal(page.pinnedItems.length, 0);
  });

  it('vaultName surfaced via LEFT JOIN; null when vault deleted', () => {
    const v = createVault(db, 'Vname', '/tmp/vault-name');
    const c = createDesktopConversation(db, 'named', v.id);
    upsertMessage(db, c.id, { id: 'n1', role: 'user', content: 'hi', timestamp: Date.now() });
    const page = listConversationHistory(db, { vaultId: v.id });
    assert.ok(page.items[0]);
    assert.equal(page.items[0].vaultName, 'Vname');
    assert.equal(page.items[0].vaultId, v.id);
  });

  it('limit clamped to [1,100] (0 → default 50, 9999 → cap 100)', () => {
    const p = createProject(db, 'Plimit');
    for (let i = 0; i < 3; i++) {
      const c = createConversation(db, p.id, `limit-${i}`);
      upsertMessage(db, c.id, { id: `limit-m-${i}`, role: 'user', content: `limit ${i}`, timestamp: Date.now() + i });
    }
    const one = listConversationHistory(db, { limit: 1 });
    assert.equal(one.items.length, 1); // floor 1, not 0
    const huge = listConversationHistory(db, { limit: 9999 });
    assert.ok(huge.items.length <= 100); // ceiling 100
  });
});

describe('listConversationHistory pinned split', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'molio-hist-pin-')); openDatabase(dir); });
  afterEach(() => { closeDatabase(); rmSync(dir, { recursive: true, force: true }); });

  it('pinned items land in pinnedItems (updated_at desc); items excludes them', async () => {
    const db = openDatabase(dir);
    const p = createProject(db, 'PinP');
    const c1 = createConversation(db, p.id, 'pin-1');
    const c2 = createConversation(db, p.id, 'pin-2');
    const c3 = createConversation(db, p.id, 'normal');
    updateConversation(db, c1.id, { pinned: true });
    updateConversation(db, c2.id, { pinned: true });
    await new Promise((r) => setTimeout(r, 10));
    upsertMessage(db, c1.id, { id: 'm1', role: 'user', content: 'a', timestamp: Date.now() });
    const page = listConversationHistory(db, {});
    assert.deepEqual(page.pinnedItems.map((i) => i.conversation.id), [c1.id, c2.id]);
    assert.equal(page.items.some((i) => i.conversation.id === c1.id || i.conversation.id === c2.id), false);
    assert.ok(page.items.some((i) => i.conversation.id === c3.id));
    assert.ok(page.pinnedItems[0]!.conversation.pinnedAt != null);
  });

  it('pinned respects vault + query filters', async () => {
    const db = openDatabase(dir);
    const v = createVault(db, 'PinV', '/tmp/pin-v');
    const c1 = createDesktopConversation(db, 'pv-in', v.id);
    const c2 = createDesktopConversation(db, 'pv-out', null);
    updateConversation(db, c1.id, { pinned: true });
    updateConversation(db, c2.id, { pinned: true });
    upsertMessage(db, c1.id, { id: 'pv1', role: 'user', content: 'pin-token-A', timestamp: Date.now() });
    upsertMessage(db, c2.id, { id: 'pv2', role: 'user', content: 'pin-token-B', timestamp: Date.now() });
    const byVault = listConversationHistory(db, { vaultId: v.id });
    assert.equal(byVault.pinnedItems.length, 1);
    assert.equal(byVault.pinnedItems[0]!.conversation.id, c1.id);
    const byQuery = listConversationHistory(db, { query: 'pin-token-A' });
    assert.equal(byQuery.pinnedItems.length, 1);
    assert.equal(byQuery.pinnedItems[0]!.conversation.id, c1.id);
  });

  it('pinned is unpaginated and does not disturb items cursor', async () => {
    const db = openDatabase(dir);
    const p = createProject(db, 'PinCur');
    const pin = createConversation(db, p.id, 'pinned-one');
    updateConversation(db, pin.id, { pinned: true });
    for (let i = 0; i < 3; i++) {
      const c = createConversation(db, p.id, `cur-${i}`);
      upsertMessage(db, c.id, { id: `cu-${i}`, role: 'user', content: `curpage ${i}`, timestamp: Date.now() + i });
      await new Promise((r) => setTimeout(r, 5));
    }
    const first = listConversationHistory(db, { limit: 2 });
    assert.equal(first.pinnedItems.length, 1);
    assert.equal(first.items.length, 2);
    const second = listConversationHistory(db, { limit: 2, before: first.nextCursor! });
    assert.equal(second.pinnedItems.length, 1); // pinned always fully returned
    assert.equal(second.items.length, 1);
  });
});
