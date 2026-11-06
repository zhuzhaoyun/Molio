import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault, listVaults } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';
import { SAMPLE_VAULT_ENTRY } from '../../src/core/sample-vault.js';

describe('POST /api/knowledge/sample-vault', () => {
  let app: Hono;
  let dataDir: string;
  let root: string;
  let sourceDir: string;
  let db: ReturnType<typeof openDatabase>;
  let vaultWatcher: VaultWatcher;
  const saved = {
    path: process.env['MOLIO_SAMPLE_VAULT_PATH'],
    source: process.env['MOLIO_SAMPLE_VAULT_SOURCE_DIR'],
  };

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'molio-sample-route-db-'));
    db = openDatabase(dataDir);
    vaultWatcher = new VaultWatcher(db);
    const rootApp = new Hono();
    rootApp.route('/api/knowledge', knowledgeRoutes(db, new RunManager(), vaultWatcher));
    app = rootApp;
  });

  after(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
    if (saved.path === undefined) delete process.env['MOLIO_SAMPLE_VAULT_PATH'];
    else process.env['MOLIO_SAMPLE_VAULT_PATH'] = saved.path;
    if (saved.source === undefined) delete process.env['MOLIO_SAMPLE_VAULT_SOURCE_DIR'];
    else process.env['MOLIO_SAMPLE_VAULT_SOURCE_DIR'] = saved.source;
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'molio-sample-route-case-'));
    sourceDir = join(root, 'source');
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, SAMPLE_VAULT_ENTRY), '# 开始使用\n');
    process.env['MOLIO_SAMPLE_VAULT_SOURCE_DIR'] = sourceDir;
    process.env['MOLIO_SAMPLE_VAULT_PATH'] = join(root, '示例知识库');
    for (const v of listVaults(db)) db.prepare('DELETE FROM vaults WHERE id = ?').run(v.id);
  });

  afterEach(async () => {
    // The provisioning route starts a real chokidar watcher; without this the
    // process would stay alive after the last test.
    for (const v of listVaults(db)) await vaultWatcher.unwatch(v.id);
    rmSync(root, { recursive: true, force: true });
  });

  it('creates on first call (201) and is idempotent on the second (200)', async () => {
    const first = await app.request('/api/knowledge/sample-vault', { method: 'POST' });
    assert.equal(first.status, 201);
    const firstBody = await first.json() as {
      vault: { id: string; path: string; name: string };
      entryFile: string;
      created: boolean;
    };
    assert.equal(firstBody.created, true);
    assert.equal(firstBody.entryFile, SAMPLE_VAULT_ENTRY);
    assert.equal(firstBody.vault.name, '示例知识库');
    assert.ok(existsSync(join(firstBody.vault.path, SAMPLE_VAULT_ENTRY)));

    const second = await app.request('/api/knowledge/sample-vault', { method: 'POST' });
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { vault: { id: string }; created: boolean };
    assert.equal(secondBody.created, false);
    assert.equal(secondBody.vault.id, firstBody.vault.id);
  });

  it('returns 400 with the F1 code when the target overlaps an existing vault', async () => {
    const existing = join(root, 'existing');
    mkdirSync(existing, { recursive: true });
    createVault(db, 'existing', existing);
    process.env['MOLIO_SAMPLE_VAULT_PATH'] = join(existing, '示例知识库');

    const res = await app.request('/api/knowledge/sample-vault', { method: 'POST' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: { code: string; message: string } };
    assert.equal(body.error.code, 'VAULT_PATH_NESTED');
    assert.ok(body.error.message.length > 0);
    assert.equal(existsSync(join(existing, '示例知识库')), false);
  });
});
