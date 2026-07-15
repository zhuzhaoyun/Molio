import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase, closeDatabase, createVault, upsertMessage, listConversationHistory } from '../../src/core/db.js';
import { ConversationService } from '../../src/core/conversations/service.js';

describe('runs route vault capture (via ConversationService + history query)', () => {
  let db: Database.Database;
  let tempDir: string;
  let conversations: ConversationService;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-runs-vault-'));
    db = openDatabase(tempDir);
    conversations = new ConversationService(db);
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('createDesktopConversation stores vaultId and history surfaces vaultName', () => {
    const v = createVault(db, 'RunsV', '/tmp/runs-v');
    const c = conversations.createDesktopConversation('hi', v.id);
    upsertMessage(db, c.id, { id: 'rv-m', role: 'user', content: 'hi', timestamp: Date.now() });
    const page = listConversationHistory(db, { vaultId: v.id });
    assert.equal(page.items.length, 1);
    const item = page.items[0]!;
    assert.equal(item.vaultName, 'RunsV');
  });
});
