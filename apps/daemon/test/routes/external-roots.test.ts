import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createVault, listExternalRoots } from '../../src/core/db.js';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';

/**
 * Mount / list / unmount of external source roots.
 *
 * This is the only surface in the feature that MUTATES the filesystem (it
 * creates and removes the directory link under <vault>/external/<label>), so
 * the assertions lean on the refusal paths: a bad target, an occupied mount
 * name, a duplicate label — each must leave the vault untouched.
 */

// openDatabase takes a DIRECTORY (it opens <dir>/app.sqlite) — never ':memory:'.
// knowledgeRoutes(db, runManager, vaultWatcher) RETURNS the Hono app (3 args).
function app() {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const watcher = { watch: async () => {}, unwatch: async () => {} };
  const a = knowledgeRoutes(db, {} as any, watcher as any);
  return { db, a };
}

/** `Response.json()` is `unknown` under the undici typings — name the shape here. */
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

describe('external-root routes', () => {
  it('adds, lists and deletes a root; mounted file appears in the tree', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    fs.writeFileSync(path.join(ext, 'mem.md'), 'hi');
    const vault = createVault(db, 'V', vaultPath);

    const add = await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: ext }),
    });
    assert.equal(add.status, 201);
    const root = (await json<any>(add)).root;
    assert.equal(root.label, path.basename(ext));

    const tree = await json<any>(await a.request(`/vaults/${vault.id}/tree`));
    const flat = JSON.stringify(tree.tree);
    assert.ok(flat.includes('external'), 'external namespace should render');
    assert.ok(flat.includes('mem.md'), 'mounted file should render');

    const del = await a.request(`/vaults/${vault.id}/external-roots/${root.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots.length, 0);
  });

  it('rejects a target inside the vault with 400', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const inner = path.join(vaultPath, 'inner'); fs.mkdirSync(inner);
    const vault = createVault(db, 'V', vaultPath);
    const res = await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: inner }),
    });
    assert.equal(res.status, 400);
  });

  it('reports valid:false when a mounted target disappears', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: ext }),
    });
    fs.rmSync(ext, { recursive: true, force: true });
    const roots = (await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots;
    assert.equal(roots[0].valid, false);
  });

  it('rejects a duplicate label with 409 and never leaves a second link', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const a1 = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const a2 = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    const post = (target: string, label: string) => a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target, label }),
    });
    assert.equal((await post(a1, 'AgentA')).status, 201);
    assert.equal((await post(a2, 'AgentA')).status, 409);
    assert.equal(fs.readdirSync(path.join(vaultPath, 'external')).length, 1);
  });

  it('refuses a label already occupied by an in-vault path and does not clobber it', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    // Writes directly under external/ are allowed (the mount is the link BELOW
    // it), so a plain in-vault file can already own the name we want.
    const occupied = path.join(vaultPath, 'external', 'AgentA');
    fs.mkdirSync(path.dirname(occupied), { recursive: true });
    fs.writeFileSync(occupied, 'mine');

    const res = await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: ext, label: 'AgentA' }),
    });
    assert.equal(res.status, 409);
    assert.equal(fs.lstatSync(occupied).isSymbolicLink(), false, 'existing path must survive');
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'mine');
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });

  it('rolls the link back when the registry insert fails', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);

    // Fail only the INSERT, so the pre-checks (which SELECT) still run for real.
    const realPrepare = db.prepare.bind(db);
    (db as any).prepare = (sql: string) => {
      if (sql.startsWith('INSERT INTO vault_external_roots')) throw new Error('disk I/O error');
      return realPrepare(sql);
    };

    const res = await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: ext, label: 'AgentA' }),
    });
    assert.equal(res.status, 409);
    (db as any).prepare = realPrepare;
    // The link created moments earlier must not outlive the failed insert.
    assert.equal(fs.readdirSync(vaultPath, { withFileTypes: true })
      .find((e) => e.name === 'external')?.isDirectory() ?? false, true);
    assert.equal(fs.readdirSync(path.join(vaultPath, 'external')).length, 0);
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });
});
