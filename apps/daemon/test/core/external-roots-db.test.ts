import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createVault, addExternalRoot, listExternalRoots, removeExternalRoot, getExternalRootByLabel } from '../../src/core/db.js';

describe('vault_external_roots CRUD', () => {
  let db: ReturnType<typeof openDatabase>;
  before(() => { db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-'))); });
  after(() => { db.close(); });

  it('adds, lists, looks up and removes a root', () => {
    const vault = createVault(db, 'V', '/tmp/v-ext');
    const row = addExternalRoot(db, vault.id, 'AgentA', '/tmp/scattered/AgentA');
    assert.equal(row.label, 'AgentA');
    assert.equal(row.target, '/tmp/scattered/AgentA');
    assert.equal(listExternalRoots(db, vault.id).length, 1);
    assert.equal(getExternalRootByLabel(db, vault.id, 'AgentA')?.id, row.id);
    removeExternalRoot(db, vault.id, row.id);
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });

  it('rejects duplicate label in the same vault', () => {
    const vault = createVault(db, 'V2', '/tmp/v-ext2');
    addExternalRoot(db, vault.id, 'Dup', '/tmp/a');
    assert.throws(() => addExternalRoot(db, vault.id, 'Dup', '/tmp/b'));
  });

  it('cascades delete when the vault is removed', () => {
    const vault = createVault(db, 'V3', '/tmp/v-ext3');
    addExternalRoot(db, vault.id, 'X', '/tmp/x');
    db.prepare('DELETE FROM vaults WHERE id = ?').run(vault.id);
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });
});
