import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, createVault, listExternalRoots } from '../../src/core/db.js';
import { removeDirectoryLink } from '../../src/core/external-roots.js';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';

/**
 * Mount / list / unmount of external source roots.
 *
 * This is the only surface in the feature that MUTATES the filesystem (it
 * creates and removes the directory link under <vault>/external/<label>), so
 * the assertions lean on the refusal and cleanup paths: a bad target, an
 * occupied mount name, a duplicate label, and — the state the whole feature is
 * built around — a link whose target was deleted out from under it.
 */

// openDatabase takes a DIRECTORY (it opens <dir>/app.sqlite) — never ':memory:'.
// knowledgeRoutes(db, runManager, vaultWatcher) RETURNS the Hono app (3 args).
function app() {
  const db = openDatabase(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-db-')));
  const watchCalls: Array<[string, string]> = [];
  const watcher = {
    watch: async (vaultId: string, vaultPath: string) => {
      watchCalls.push([vaultId, vaultPath]);
    },
    unwatch: async () => {},
  };
  const a = knowledgeRoutes(db, {} as any, watcher as any);
  return { db, a, watchCalls };
}

/** `Response.json()` is `unknown` under the undici typings — name the shape here. */
async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/**
 * lstat-based presence: true for a DANGLING link too. `fs.existsSync` is the
 * wrong primitive for the mount path and returns false there.
 */
function linkExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function post(a: any, vaultId: string, body: unknown): Promise<Response> {
  return a.request(`/vaults/${vaultId}/external-roots`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('external-root routes', () => {
  it('adds, lists and deletes a root; mounted file appears in the tree', async () => {
    const { db, a, watchCalls } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    fs.writeFileSync(path.join(ext, 'mem.md'), 'hi');
    const vault = createVault(db, 'V', vaultPath);

    const add = await post(a, vault.id, { target: ext });
    assert.equal(add.status, 201);
    const root = (await json<any>(add)).root;
    assert.equal(root.label, path.basename(ext));
    // Wire shape: the route maps the DB row, so the payload is camelCase and
    // carries `valid`, exactly like every other KB endpoint. A regression to
    // raw column names would silently hand the UI `vaultId: undefined`.
    assert.equal(root.vaultId, vault.id);
    assert.equal(root.target, fs.realpathSync(ext));
    assert.equal(root.valid, true);
    assert.ok(root.createdAt > 0);
    assert.equal(root.vault_id, undefined);
    // Mounting re-arms the watcher so the new coverage takes effect.
    assert.deepEqual(watchCalls, [[vault.id, vaultPath]]);

    // A live mount (target present, link in place) is the only `valid:true`.
    const listed = (await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots;
    assert.equal(listed[0].valid, true);
    // Same shape as the POST response — one contract, two entry points.
    assert.deepEqual(Object.keys(listed[0]).sort(), Object.keys(root).sort());
    assert.equal(listed[0].vaultId, vault.id);

    const tree = await json<any>(await a.request(`/vaults/${vault.id}/tree`));
    const flat = JSON.stringify(tree.tree);
    assert.ok(flat.includes('external'), 'external namespace should render');
    assert.ok(flat.includes('mem.md'), 'mounted file should render');

    const del = await a.request(`/vaults/${vault.id}/external-roots/${root.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal((await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots.length, 0);
    // …and again on unmount, so the dropped root's coverage is released.
    assert.equal(watchCalls.length, 2);
  });

  // The registry contract is "registered ⇒ visible". A target whose basename is
  // an artifact name (`dist`, `out`, `env`, anything dot-prefixed) is the normal
  // case for a build-output mount, and the default label is that basename — so
  // the two surfaces must still agree: valid:true in the list AND a node in the
  // tree. Before the fix the tree swallowed it silently.
  it('renders a mount whose target basename is a pruned name', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-')), 'dist');
    fs.mkdirSync(ext);
    fs.writeFileSync(path.join(ext, 'artifact.md'), 'hi');
    const vault = createVault(db, 'V', vaultPath);

    const add = await post(a, vault.id, { target: ext });
    assert.equal(add.status, 201);
    assert.equal((await json<any>(add)).root.label, 'dist');

    const listed = (await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots;
    assert.equal(listed[0].valid, true);

    const tree = await json<any>(await a.request(`/vaults/${vault.id}/tree`));
    const flat = JSON.stringify(tree.tree);
    assert.ok(flat.includes('dist'), 'the pruned-name mount should render');
    assert.ok(flat.includes('artifact.md'), 'mounted content should render');
  });

  it('rejects a target inside the vault with 400', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const inner = path.join(vaultPath, 'inner'); fs.mkdirSync(inner);
    const vault = createVault(db, 'V', vaultPath);
    const res = await post(a, vault.id, { target: inner });
    assert.equal(res.status, 400);
  });

  it('reports valid:false when a mounted target disappears', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    await post(a, vault.id, { target: ext });
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
    assert.equal((await post(a, vault.id, { target: a1, label: 'AgentA' })).status, 201);
    assert.equal((await post(a, vault.id, { target: a2, label: 'AgentA' })).status, 409);
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

    const res = await post(a, vault.id, { target: ext, label: 'AgentA' });
    assert.equal(res.status, 409);
    assert.equal(fs.lstatSync(occupied).isSymbolicLink(), false, 'existing path must survive');
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'mine');
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });

  it('reports an internal error and rolls the link back when the registry insert fails', async () => {
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

    const res = await post(a, vault.id, { target: ext, label: 'AgentA' });
    assert.equal(res.status, 500);
    assert.equal((await json<any>(res)).error.code, 'INTERNAL');
    (db as any).prepare = realPrepare;
    // The link created moments earlier must not outlive the failed insert.
    assert.equal(fs.readdirSync(path.join(vaultPath, 'external')).length, 0);
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });

  it('removes a dangling link on unmount and lets the same label be re-mounted', async () => {
    const { db, a, watchCalls } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-')), 'AgentA');
    fs.mkdirSync(ext);
    const vault = createVault(db, 'V', vaultPath);
    const linkPath = path.join(vaultPath, 'external', 'AgentA');

    assert.equal((await post(a, vault.id, { target: ext, label: 'AgentA' })).status, 201);
    assert.equal(linkExists(linkPath), true);
    assert.equal(watchCalls.length, 1);

    // Delete the folder the link points at: the link now dangles, which is the
    // normal "folder deleted / drive unplugged" state of this feature. Note
    // existsSync is false here while the path is very much still occupied.
    fs.rmSync(ext, { recursive: true, force: true });
    assert.equal(fs.existsSync(linkPath), false);
    assert.equal(linkExists(linkPath), true);

    const listed = (await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots;
    assert.equal(listed[0].valid, false);

    const del = await a.request(`/vaults/${vault.id}/external-roots/${listed[0].id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    // The dangling link must be gone — otherwise nothing could ever clean it up
    // (the row is deleted, so DELETE 404s and no other surface owns the path).
    assert.throws(
      () => fs.lstatSync(linkPath),
      (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT',
    );
    assert.equal((await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots.length, 0);
    assert.equal(watchCalls.length, 2);

    // …and the label is usable again. Before the fix the leftover link was
    // invisible to the guard and made symlinkSync fail with EEXIST (500).
    fs.mkdirSync(ext);
    assert.equal((await post(a, vault.id, { target: ext, label: 'AgentA' })).status, 201);
    assert.equal(linkExists(linkPath), true);
    assert.equal(watchCalls.length, 3);
  });

  it('drops the row but keeps an in-vault file that took over the mount name', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-x-'));
    const vault = createVault(db, 'V', vaultPath);
    const linkPath = path.join(vaultPath, 'external', 'AgentA');

    const add = await post(a, vault.id, { target: ext, label: 'AgentA' });
    assert.equal(add.status, 201);
    const root = (await json<any>(add)).root;

    // The link disappears out of band and a plain user file takes the name.
    // external/ is in-vault-writable by design, so unmount must not unlink it.
    removeDirectoryLink(linkPath);
    fs.writeFileSync(linkPath, 'precious');

    // The row is now lying about liveness: target is fine, the link is not.
    const listed = (await json<any>(await a.request(`/vaults/${vault.id}/external-roots`))).roots;
    assert.equal(listed[0].valid, false);

    const del = await a.request(`/vaults/${vault.id}/external-roots/${root.id}`, { method: 'DELETE' });
    assert.equal(del.status, 204);
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'precious');
    assert.equal(listExternalRoots(db, vault.id).length, 0);
  });

  it('rejects a null JSON body with 400 instead of throwing', async () => {
    const { db, a } = app();
    const vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'molio-v-'));
    const vault = createVault(db, 'V', vaultPath);
    const res = await a.request(`/vaults/${vault.id}/external-roots`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    });
    assert.equal(res.status, 400);
  });
});
