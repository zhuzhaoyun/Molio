import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';

const JSON_HDR = { 'Content-Type': 'application/json' };

describe('写路径索引挂钩', () => {
  let app: Hono;
  let vaultDir: string;
  let tempDir: string;
  let V: string;

  before(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'molio-ksw-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-ksw-vault-'));
    const db = openDatabase(tempDir);
    V = createVault(db, 'hook-vault', vaultDir).id;
    const root = new Hono();
    root.route('/api/knowledge', knowledgeRoutes(db, new RunManager(), new VaultWatcher(db)));
    app = root;
  });

  after(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  async function writeViaApi(rel: string, content: string): Promise<void> {
    const res = await app.request(`/api/knowledge/vaults/${V}/files/${encodeURIComponent(rel)}`, {
      method: 'POST', headers: JSON_HDR, body: JSON.stringify({ content }),
    });
    assert.equal(res.status, 200);
  }
  async function hits(q: string): Promise<string[]> {
    const res = await app.request(`/api/knowledge/vaults/${V}/search?q=${encodeURIComponent(q)}`);
    const body = await res.json() as { results: Array<{ filePath: string }> };
    return body.results.map((r) => r.filePath);
  }

  test('写文件 → 立即可搜；重写 → 新词可搜旧词不可搜', async () => {
    await writeViaApi('notes/刑法.md', '盗刷指冒用他人信用卡');
    assert.deepEqual(await hits('冒用他人'), ['notes/刑法.md']);
    await writeViaApi('notes/刑法.md', '改写后的正当防卫内容');
    assert.deepEqual(await hits('正当防卫'), ['notes/刑法.md']);
    assert.deepEqual(await hits('冒用他人'), []);
  });

  test('删文件 → 立即不可搜', async () => {
    await writeViaApi('a.md', '待删除内容ABCD');
    assert.equal((await hits('内容ABCD')).length, 1);
    const res = await app.request(`/api/knowledge/vaults/${V}/files/${encodeURIComponent('a.md')}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(await hits('内容ABCD'), []);
  });

  test('改名 → 新路径可搜、旧路径无幽灵命中', async () => {
    await writeViaApi('old.md', '改名保留内容EFGH');
    const res = await app.request(`/api/knowledge/vaults/${V}/files/old.md`, {
      method: 'PUT', headers: JSON_HDR, body: JSON.stringify({ newPath: 'notes/renamed.md' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await hits('保留内容EFGH'), ['notes/renamed.md']);
  });

  test('改目录名 → 新路径下文件可搜（目录也要走索引更新）', async () => {
    await writeViaApi('olddir/x.md', '目录改名内容AB12');
    const res = await app.request(`/api/knowledge/vaults/${V}/files/${encodeURIComponent('olddir')}`, {
      method: 'PUT', headers: JSON_HDR, body: JSON.stringify({ newPath: 'newdir' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await hits('目录改名内容AB12'), ['newdir/x.md']);
  });

  test('导入 → 立即可搜', async () => {
    const fd = new FormData();
    fd.set('targetDir', 'raw');
    fd.set('conflict', 'skip');
    fd.append('files', new Blob(['导入文件的盗刷内容IJKL'], { type: 'text/markdown' }), 'imported.md');
    const res = await app.request(`/api/knowledge/vaults/${V}/import`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);
    assert.deepEqual(await hits('盗刷内容IJKL'), ['raw/imported.md']);
  });

  test('删目录 → 目录下全部不可搜', async () => {
    await writeViaApi('raw/feishu/m1.md', '目录删除标记MM11');
    await writeViaApi('raw/feishu/m2.md', '目录删除标记MM22');
    await writeViaApi('raw/keep.md', '目录外保留KK99');
    const res = await app.request(`/api/knowledge/vaults/${V}/dirs/${encodeURIComponent('raw/feishu')}`, { method: 'DELETE' });
    assert.equal(res.status, 204);
    assert.deepEqual(await hits('删除标记MM11'), []);
    assert.deepEqual(await hits('删除标记MM22'), []);
    assert.deepEqual(await hits('保留KK99'), ['raw/keep.md']);
  });
});
