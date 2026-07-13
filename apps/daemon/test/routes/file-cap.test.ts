import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';

// Lower caps so small real files can exercise tooLarge/refuse branches.
// Must be set BEFORE the route module (and therefore encoding.ts) is loaded.
process.env.MOLIO_MAX_VIEW_SIZE = String(1024 * 1024);
process.env.MOLIO_HARD_CAP = String(2 * 1024 * 1024);

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('GET /vaults/:id/files/* force + 413', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let vaultId: string;

  before(async () => {
    const { knowledgeRoutes } = await import('../../src/routes/knowledge.js');

    tempDir = mkdtempSync(join(tmpdir(), 'molio-file-cap-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-vault-cap-'));
    const db = openDatabase(tempDir);
    const vault = createVault(db, 'cap-vault', vaultDir);
    vaultId = vault.id;

    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, new RunManager(), new VaultWatcher(db)));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns tooLarge card (no content) for file between soft and hard cap', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x61); // 1 MB + 10 bytes
    writeFileSync(join(vaultDir, 'big.txt'), big);

    const res = await app.request(`/api/knowledge/vaults/${vaultId}/files/big.txt`);
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body.tooLarge, true);
    assert.equal(body.content, '');
    assert.equal(body.encoding, 'utf-8');
  });

  it('force=1 loads full content between soft and hard cap', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/files/big.txt?force=1`);
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body.tooLarge, undefined);
    assert.equal((body.content as string).length, 1024 * 1024 + 10);
  });

  it('returns 413 above hard cap even with force', async () => {
    const huge = Buffer.alloc(2 * 1024 * 1024 + 10, 0x61); // > hard cap
    writeFileSync(join(vaultDir, 'huge.txt'), huge);

    const res = await app.request(
      `/api/knowledge/vaults/${vaultId}/files/huge.txt?force=1`,
    );
    const body = await json(res);

    assert.equal(res.status, 413);
    assert.equal((body.error as Record<string, unknown>)?.code, 'FILE_TOO_LARGE');
  });
});
