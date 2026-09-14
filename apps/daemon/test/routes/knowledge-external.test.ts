import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault, addExternalRoot } from '../../src/core/db.js';
import { createDirectoryLink } from '../../src/core/external-roots.js';

/**
 * Route-level wiring of the external-root read surface.
 *
 * Every read endpoint has to consult the same registry the tree scan does —
 * otherwise a mounted folder shows up in the UI but 404s / comes back empty
 * the moment the user clicks it. POST endpoints stay mounted-free (read-only),
 * except that a rejected import must be REPORTED in the response, not dropped.
 */

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Knowledge routes — external source roots', () => {
  let app: Hono;
  let tempDir: string;
  let vaultDir: string;
  let extDir: string;
  let vaultId: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-ext-routes-'));
    vaultDir = join(tempDir, 'vault');
    extDir = mkdtempSync(join(tmpdir(), 'molio-ext-src-'));
    mkdirSync(vaultDir, { recursive: true });

    writeFileSync(join(extDir, 'mem.md'), '# 记忆\n这里有一个 needle 关键词\n');
    mkdirSync(join(extDir, 'sub'));
    writeFileSync(join(extDir, 'sub', 'deep.md'), 'needle again\n');
    // 1x1 PNG — enough to prove the raw route serves real bytes.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(extDir, 'pic.png'), png);

    // The mount is a real directory link under <vault>/external/<label>.
    mkdirSync(join(vaultDir, 'external'));
    createDirectoryLink(extDir, join(vaultDir, 'external', 'AgentA'));

    const db = openDatabase(tempDir);
    vaultId = createVault(db, 'ext-vault', vaultDir).id;
    addExternalRoot(db, vaultId, 'AgentA', extDir);

    // Real signature: three args, RETURNS the Hono app. The watcher is stubbed
    // so the test never starts chokidar. Mount under /api/knowledge because the
    // file/raw handlers slice `c.req.path` by that literal prefix.
    const root = new Hono();
    root.route(
      '/api/knowledge',
      knowledgeRoutes(db, {} as never, {
        watch: async () => {},
        unwatch: async () => {},
      } as never),
    );
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(extDir, { recursive: true, force: true });
  });

  it('lists mounted files in the tree', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/tree`);
    assert.equal(res.status, 200);
    const tree = (await json(res))['tree'] as Array<Record<string, unknown>>;
    const external = tree.find((n) => n['path'] === 'external');
    assert.ok(external, 'external/ node exists');
    const agentA = (external['children'] as Array<Record<string, unknown>>).find((n) => n['name'] === 'AgentA');
    assert.ok(agentA, 'mount renders under external/AgentA');
    const names = (agentA['children'] as Array<Record<string, unknown>>).map((n) => n['name']).sort();
    assert.deepEqual(names, ['mem.md', 'pic.png', 'sub']);
  });

  it('reads a mounted file through its virtual path', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/files/external/AgentA/mem.md`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.ok((body['content'] as string).includes('needle'));
    assert.equal(body['path'], 'external/AgentA/mem.md');
  });

  it('reads a mounted file in a subdirectory', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/files/external/AgentA/sub/deep.md`);
    assert.equal(res.status, 200);
    assert.ok(((await json(res))['content'] as string).includes('needle'));
  });

  it('resolves a mounted path back to the same virtual path', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/resolve/external/AgentA/mem.md`);
    assert.equal(res.status, 200);
    assert.deepEqual(await json(res), { path: 'external/AgentA/mem.md' });
  });

  it('finds mounted content in the search results', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=needle`);
    assert.equal(res.status, 200);
    const results = (await json(res))['results'] as Array<Record<string, unknown>>;
    assert.deepEqual(
      results.map((r) => r['filePath']).sort(),
      ['external/AgentA/mem.md', 'external/AgentA/sub/deep.md'],
    );
  });

  it('serves a mounted binary through the raw route', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/raw/external/AgentA/pic.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(buf, readFileSync(join(extDir, 'pic.png')));
  });

  // The raw route must apply the same realpath boundary as readFile: a link
  // inside the vault pointing OUT of it used to be streamed verbatim, because
  // resolveFilePath only checks the lexical path.
  it('refuses to stream a vault-internal link that escapes the vault', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'molio-ext-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
    createDirectoryLink(outside, join(vaultDir, 'escape'));
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/raw/escape/secret.txt`);
    assert.equal(res.status, 403);
    assert.deepEqual(await json(res), {
      error: { code: 'FORBIDDEN', message: 'Path traversal not allowed' },
    });
    rmSync(join(vaultDir, 'escape'));
    rmSync(outside, { recursive: true, force: true });
  });

  // The mount is read-only: the import has to be refused per file, and the
  // refusal must reach the client (Task 8 owns the user-facing copy).
  it('reports external_readonly when importing into a mount', async () => {
    const fd = new FormData();
    fd.append('targetDir', 'external/AgentA');
    fd.append('conflict', 'skip');
    fd.append('files', new File([Buffer.from('x')], 'new.md'));
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/import`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.deepEqual(body['imported'], []);
    assert.deepEqual(body['errors'], [{ file: 'new.md', reason: 'external_readonly' }]);
    // nothing landed in the user's folder
    assert.equal(readFileSync(join(extDir, 'mem.md'), 'utf-8').includes('needle'), true);
    assert.throws(() => readFileSync(join(extDir, 'new.md')));
  });

  // No external roots registered → the vault behaves exactly as before.
  it('keeps a root-less vault unchanged', async () => {
    const otherDir = mkdtempSync(join(tmpdir(), 'molio-plain-'));
    writeFileSync(join(otherDir, 'plain.md'), 'needle');
    const db = openDatabase(tempDir);
    const plainId = createVault(db, 'plain-vault', otherDir).id;
    const tree = (await json(await app.request(`/api/knowledge/vaults/${plainId}/tree`)))['tree'] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(tree.map((n) => n['path']), ['plain.md']);
    const results = (await json(await app.request(`/api/knowledge/vaults/${plainId}/search?q=needle`)))['results'] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(results.map((r) => r['filePath']), ['plain.md']);
    rmSync(otherDir, { recursive: true, force: true });
  });
});
