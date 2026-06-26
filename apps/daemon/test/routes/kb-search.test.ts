import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

describe('Knowledge routes — full-text search', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let vaultId: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-search-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-search-vault-'));
    // 两个文件，一个命中一个不命中 + 子目录里一个命中
    writeFileSync(join(vaultDir, 'design.md'), '# 设计\n讨论了微服务拆分的三种方案\n');
    writeFileSync(join(vaultDir, 'notes.md'), '# 笔记\n今天天气不错\n');
    mkdirSync(join(vaultDir, 'sub'));
    writeFileSync(join(vaultDir, 'sub', 'arch.md'), '架构评审：服务拆分采用领域驱动\n');

    const db = openDatabase(tempDir);
    const vault = createVault(db, 'search-vault', vaultDir);
    vaultId = vault.id;
    // 路由用硬编码 /api/knowledge 前缀做 path 提取，必须挂到该前缀
    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, new RunManager()));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns matching files with snippet', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=拆分`);
    assert.equal(res.status, 200);
    const body = await json(res);
    const results = body['results'] as Array<Record<string, unknown>>;
    assert.equal(results.length, 2);
    const paths = results.map((r) => r['filePath'] as string).sort();
    assert.deepEqual(paths, ['design.md', 'sub/arch.md']);
    for (const r of results) {
      assert.ok((r['snippet'] as string).includes('拆分'));
      assert.ok((r['fileName'] as string).endsWith('.md'));
    }
  });

  it('returns empty results for non-matching query', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=不存在的词xyz`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal((body['results'] as unknown[]).length, 0);
  });

  it('returns 400 for empty query', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=`);
    assert.equal(res.status, 400);
  });

  it('returns 404 for unknown vault', async () => {
    const res = await app.request(`/api/knowledge/vaults/nope/search?q=foo`);
    assert.equal(res.status, 404);
  });

  it('respects limit and sets truncated=true', async () => {
    // 5 个文件都命中 "关键词"
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(vaultDir, `f${i}.md`), `内容包含关键词词\n`);
    }
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=关键词&limit=2`);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal((body['results'] as unknown[]).length, 2);
    assert.equal(body['truncated'], true);
  });

  it('falls back to default limit for invalid limit=abc', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=拆分&limit=abc`);
    assert.equal(res.status, 200);
    const body = await json(res);
    const results = body['results'] as Array<Record<string, unknown>>;
    // 默认 limit=20，两个文件都命中，应该返回 2 个结果
    assert.equal(results.length, 2);
    assert.equal(body['truncated'], false);
  });

  it('falls back to default limit for limit=0', async () => {
    const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=拆分&limit=0`);
    assert.equal(res.status, 200);
    const body = await json(res);
    const results = body['results'] as Array<Record<string, unknown>>;
    // 默认 limit=20，两个文件都命中，应该返回 2 个结果
    assert.equal(results.length, 2);
    assert.equal(body['truncated'], false);
  });

  it('skips unreadable files without failing the whole vault search', async () => {
    if (process.platform === 'win32') {
      // chmod is unreliable on Windows; skip this regression test there
      return;
    }

    const readablePath = join(vaultDir, 'readable.md');
    const unreadablePath = join(vaultDir, 'unreadable.md');

    writeFileSync(readablePath, '# 可读\n包含关键词 微服务 的内容\n');
    writeFileSync(unreadablePath, '# 不可读\n包含关键词 微服务 的内容\n');
    chmodSync(unreadablePath, 0o000);

    try {
      const res = await app.request(`/api/knowledge/vaults/${vaultId}/search?q=微服务`);
      assert.equal(res.status, 200);
      const body = await json(res);
      const results = body['results'] as Array<Record<string, unknown>>;
      const paths = results.map((r) => r['filePath'] as string);
      assert.ok(paths.includes('readable.md'), 'should return the readable matching file');
      assert.ok(!paths.includes('unreadable.md'), 'should skip the unreadable file');
    } finally {
      chmodSync(unreadablePath, 0o644);
    }
  });
});
