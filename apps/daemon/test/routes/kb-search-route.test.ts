import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { maintenanceRoutes } from '../../src/routes/maintenance.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';

describe('搜索路由（FTS5 实现）', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let vaultId: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-ksr-test-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-ksr-vault-'));
    const db = openDatabase(tempDir);
    vaultId = createVault(db, 'test-vault', vaultDir).id;
    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, new RunManager(), new VaultWatcher(db)));
    root.route('/api/maintenance', maintenanceRoutes(db));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('首搜建库后按相关性排序（词频高者靠前）', async () => {
    // ≥3 字查询才走 FTS5 bm25 排序（<3 字走 LIKE 回退，无排序）
    writeFileSync(join(vaultDir, 'a.md'), '信用卡盗刷的简要提及', 'utf-8');
    writeFileSync(join(vaultDir, 'b.md'), '信用卡盗刷信用卡盗刷信用卡盗刷专题笔记', 'utf-8');
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=${encodeURIComponent('信用卡盗刷')}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { results: Array<{ filePath: string }>; truncated: boolean };
    assert.equal(body.truncated, false);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0]!.filePath, 'b.md');
  });

  it('响应形状保持 SearchResult（filePath/fileName/snippet）', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=${encodeURIComponent('专题笔记')}`);
    const body = await res.json() as { results: Array<Record<string, unknown>> };
    const r = body.results[0]!;
    assert.ok(typeof r['filePath'] === 'string');
    assert.ok(typeof r['fileName'] === 'string');
    assert.ok(typeof r['snippet'] === 'string');
  });

  it('空 q 400、未知 vault 404（原语义保留）', async () => {
    assert.equal((await app.request(`/api/knowledge/vaults/${vaultId}/search?q=%20`)).status, 400);
    assert.equal((await app.request('/api/knowledge/vaults/nope/search?q=abc')).status, 404);
  });

  it('rebuild 端点：清空重建返回 vault 数与 ok', async () => {
    const res = await app.request('/api/maintenance/rebuild-vault-fts', { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; vaults: number };
    assert.equal(body.ok, true);
    assert.equal(body.vaults, 1);
    // 重建后原文件仍可搜（索引未丢）
    const after = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=${encodeURIComponent('专题笔记')}`);
    const afterBody = await after.json() as { results: unknown[] };
    assert.ok(afterBody.results.length >= 1);
  });
});
