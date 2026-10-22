import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { knowledgeRoutes } from '../../src/routes/knowledge.js';
import { TreeCache } from '../../src/core/tree-cache.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';
import { RunManager } from '../../src/core/RunManager.js';
import { VaultWatcher } from '../../src/core/vault-watcher.js';

/**
 * 文件树路由 × 缓存的契约测试。
 *
 * 性能背景：GET /vaults/:id/tree 每次同步 scanTree 整棵目录树（移动盘大库几秒，
 * 期间阻塞 daemon），而打开知识库 / 切库 / 聚焦都在调它。这里用「外部新增文件
 * 在失效前不可见」来**证明确实走了缓存**；用「API 写文件后立即可见」钉死就地
 * 失效——那是无缓存时代就有的即时性，属于不可回归的行为。
 *
 * 每个用例独立 vault：缓存命中断言对「目录里有哪些文件」敏感，共享目录会互相污染。
 */

type Node = { name: string };

async function names(res: Response): Promise<string[]> {
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tree: Node[] };
  return body.tree.map((n) => n.name).sort();
}

describe('Knowledge routes — tree cache', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'molio-treecache-data-'));
  const db = openDatabase(dataDir);

  after(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** 每个用例一个独立 vault，用完即清。 */
  function makeVault(): { vaultDir: string; vaultId: string; app: (cache: TreeCache, gate?: (id: string) => boolean) => Hono; cleanup: () => void } {
    const vaultDir = mkdtempSync(join(tmpdir(), 'molio-treecache-vault-'));
    writeFileSync(join(vaultDir, 'a.md'), '# A\n');
    const vaultId = createVault(db, 'tree-cache-vault', vaultDir).id;
    const app = (cache: TreeCache, gate?: (id: string) => boolean) => {
      const root = new Hono();
      const routes = gate
        ? knowledgeRoutes(db, new RunManager(), new VaultWatcher(db), cache, gate)
        : knowledgeRoutes(db, new RunManager(), new VaultWatcher(db), cache);
      root.route('/api/knowledge', routes);
      return root;
    };
    return { vaultDir, vaultId, app, cleanup: () => rmSync(vaultDir, { recursive: true, force: true }) };
  }

  it('命中缓存：外部新增的文件在失效前不可见，invalidate 后可见', async () => {
    const { vaultDir, vaultId, app, cleanup } = makeVault();
    try {
      const cache = new TreeCache();
      const treeOf = () => app(cache).request(`/api/knowledge/vaults/${vaultId}/tree`);

      assert.deepEqual(await names(await treeOf()), ['a.md']);

      writeFileSync(join(vaultDir, 'b.md'), '# B\n');
      assert.deepEqual(
        await names(await treeOf()),
        ['a.md'],
        'vault 内容变了但没收到 tree-changed → 仍是缓存里的树（这就是缓存生效的证据）',
      );

      cache.invalidate(vaultId); // 相当于 VaultWatcher 的 tree-changed
      assert.deepEqual(await names(await treeOf()), ['a.md', 'b.md']);
    } finally {
      cleanup();
    }
  });

  it('API 写文件后树立即可见（就地失效，不等 chokidar）', async () => {
    const { vaultId, app, cleanup } = makeVault();
    try {
      const cache = new TreeCache();
      const mounted = app(cache);
      const treeOf = () => mounted.request(`/api/knowledge/vaults/${vaultId}/tree`);
      await treeOf(); // 预热缓存

      const res = await mounted.request(`/api/knowledge/vaults/${vaultId}/files/created-via-api.md`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# created\n' }),
      });
      assert.equal(res.status, 200);

      assert.deepEqual(
        await names(await treeOf()),
        ['a.md', 'created-via-api.md'],
        '用户刚创建的文件必须立即可见——无缓存时代就是即时的，缓存不能把它变成 1-2s 的陈旧窗',
      );
    } finally {
      cleanup();
    }
  });

  it('监听未就绪 → 不吃缓存，外部写立即可见（每次都重扫）', async () => {
    const { vaultDir, vaultId, app, cleanup } = makeVault();
    try {
      const cache = new TreeCache();
      let ready = false;
      const mounted = app(cache, () => ready);
      const treeOf = () => mounted.request(`/api/knowledge/vaults/${vaultId}/tree`);

      assert.deepEqual(await names(await treeOf()), ['a.md']);
      writeFileSync(join(vaultDir, 'not-ready.md'), '# n\n');
      assert.deepEqual(
        await names(await treeOf()),
        ['a.md', 'not-ready.md'],
        'watcher 未就绪 → 没有失效信号可用 → 必须退回每次重扫',
      );

      ready = true; // 就绪后缓存接管：与「命中缓存」同判据
      const snapshot = await names(await treeOf());
      writeFileSync(join(vaultDir, 'ready-stale.md'), '# s\n');
      assert.deepEqual(await names(await treeOf()), snapshot);
      cache.invalidate(vaultId);
      assert.ok((await names(await treeOf())).includes('ready-stale.md'));
    } finally {
      cleanup();
    }
  });

  it('vault 不存在时先 404，不碰缓存', async () => {
    const { app, cleanup } = makeVault();
    try {
      const res = app(new TreeCache()).request('/api/knowledge/vaults/does-not-exist/tree');
      assert.equal((await res).status, 404);
    } finally {
      cleanup();
    }
  });
});
