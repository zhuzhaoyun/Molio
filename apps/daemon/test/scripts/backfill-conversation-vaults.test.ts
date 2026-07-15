import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { openDatabase, closeDatabase, createProject, createConversation, createDesktopConversation, createVault, upsertMessage } from '../../src/core/db.js';
import { backfillConversationVaults } from '../../src/scripts/backfill-conversation-vaults.js';
import type Database from 'better-sqlite3';

describe('backfillConversationVaults', () => {
  let db: Database.Database;
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-backfill-'));
    db = openDatabase(tempDir);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not throw on empty db', () => {
    assert.doesNotThrow(() => backfillConversationVaults(db));
  });

  it('is idempotent (run twice, no error, no spurious writes)', () => {
    const v = createVault(db, 'BV', '/tmp/backfill-v');
    const c = createDesktopConversation(db, 'before', null); // vault_id null (pre-existing)
    upsertMessage(db, c.id, { id: 'bf-m', role: 'user', content: 'hi', timestamp: Date.now() });
    backfillConversationVaults(db);
    const after1 = db.prepare('SELECT vault_id FROM conversations WHERE id=?').get(c.id) as { vault_id: string | null };
    backfillConversationVaults(db);
    const after2 = db.prepare('SELECT vault_id FROM conversations WHERE id=?').get(c.id) as { vault_id: string | null };
    // Conservative strategy: cannot infer cwd → stays null. Idempotent.
    assert.equal(after1.vault_id, after2.vault_id);
  });
});