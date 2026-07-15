import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  openDatabase, closeDatabase, createDesktopConversation, createVault,
  deleteVault, getConversation, upsertMessage, listConversationHistory,
} from '../../src/core/db.js';
import type Database from 'better-sqlite3';

describe('createDesktopConversation vaultId', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-vault-col-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes vaultId when provided', () => {
    const v = createVault(db, 'V', '/tmp/vc-v');
    const c = createDesktopConversation(db, 't', v.id);
    const got = getConversation(db, c.id);
    // getConversation returns Conversation (no vaultId field); check raw row.
    const raw = db.prepare('SELECT vault_id FROM conversations WHERE id = ?').get(c.id) as { vault_id: string | null };
    assert.equal(raw.vault_id, v.id);
  });

  it('writes null vaultId when not provided', () => {
    const c = createDesktopConversation(db, 't2', null);
    const raw = db.prepare('SELECT vault_id FROM conversations WHERE id = ?').get(c.id) as { vault_id: string | null };
    assert.equal(raw.vault_id, null);
  });

  it('deleting a vault does not cascade-delete its conversations', () => {
    const v = createVault(db, 'Vdel', '/tmp/vc-del');
    const c = createDesktopConversation(db, 't3', v.id);
    upsertMessage(db, c.id, { id: 'vc-m', role: 'user', content: 'hi', timestamp: Date.now() });
    deleteVault(db, v.id);
    // conversation still exists, vault_id now dangles
    const raw = db.prepare('SELECT vault_id FROM conversations WHERE id = ?').get(c.id) as { vault_id: string | null };
    assert.equal(raw.vault_id, v.id); // unchanged — no FK cascade
    // history LEFT JOIN yields vaultName null but item still present
    const page = listConversationHistory(db, { vaultId: v.id });
    assert.equal(page.items.length, 1);
    const item = page.items[0]!;
    assert.equal(item.vaultName, null);
  });
});
