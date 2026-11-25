import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from '../../src/core/db.js';

test('database migration creates administrator tables and preserves existing data on reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'molio-access-migration-'));
  try {
    let db = openDatabase(dir);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('admin_sessions', 'admin_credential_state') ORDER BY name").all();
    assert.deepEqual(tables, [{ name: 'admin_credential_state' }, { name: 'admin_sessions' }]);
    db.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?)').run('digest', 1, 2, 'credential');
    closeDatabase();
    db = openDatabase(dir);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM admin_sessions').get() as { n: number }).n, 1);
  } finally { closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
});
