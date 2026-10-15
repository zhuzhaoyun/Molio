import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Hono } from 'hono';
import { graphRoutes } from '../../src/routes/graph.js';
import { GraphCache } from '../../src/core/graph-cache.js';
import { openDatabase, closeDatabase, createVault } from '../../src/core/db.js';

/**
 * 图谱路由 × 缓存的契约测试。
 *
 * 性能背景：buildGraph 同步整库扫描（移动盘大库实测 5.2s，期间阻塞 daemon）。
 * 打开图谱、每次切 scope 都在调它，所以「同一 vault 只算一次」是必须钉死的行为。
 * 这里用「新增文件在失效前不可见」来**证明确实走了缓存**——只看返回值是看不出
 * 命中与否的（重建得到的图长得一样）。
 */

type Node = { key: string };

async function nodesOf(res: Response): Promise<string[]> {
  assert.equal(res.status, 200);
  const body = (await res.json()) as { nodes: Node[] };
  return body.nodes.map((n) => n.key).sort();
}

describe('Graph routes — per-vault cache', () => {
  let dataDir: string;
  let vaultDir: string;
  let vaultId: string;
  let db: ReturnType<typeof openDatabase>;

  before(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'molio-graphcache-data-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'molio-graphcache-vault-'));
    writeFileSync(join(vaultDir, 'a.md'), '# A\n\n[[b]]\n');
    writeFileSync(join(vaultDir, 'b.md'), '# B\n\n[[a]]\n');
    db = openDatabase(dataDir);
    vaultId = createVault(db, 'cache-vault', vaultDir).id;
  });

  after(() => {
    closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  function appWith(cache: GraphCache, isCacheable?: (vaultId: string) => boolean): Hono {
    const root = new Hono();
    root.route('/api/graph', isCacheable ? graphRoutes(db, cache, isCacheable) : graphRoutes(db, cache));
    return root;
  }

  it('全量图命中缓存：失效前新增的文件不可见，invalidate 后可见', async () => {
    const cache = new GraphCache();
    const app = appWith(cache);

    assert.deepEqual(await nodesOf(await app.request(`/api/graph/${vaultId}`)), ['a.md', 'b.md']);

    writeFileSync(join(vaultDir, 'c.md'), '# C\n\n[[a]]\n');
    assert.deepEqual(
      await nodesOf(await app.request(`/api/graph/${vaultId}`)),
      ['a.md', 'b.md'],
      'vault 内容变了但没收到 tree-changed → 仍是缓存里的图（这就是缓存生效的证据）',
    );

    cache.invalidate(vaultId); // 相当于 VaultWatcher 的 tree-changed
    assert.deepEqual(await nodesOf(await app.request(`/api/graph/${vaultId}`)), ['a.md', 'b.md', 'c.md']);
  });

  it('局部图复用同一份全量图缓存（切 scope 不重扫整库）', async () => {
    const cache = new GraphCache();
    const app = appWith(cache);
    const local = (app: Hono) =>
      app.request(`/api/graph/${vaultId}/local?scope=file&path=b.md&depth=1`);

    assert.deepEqual(await nodesOf(await local(app)), ['a.md', 'b.md']);

    writeFileSync(join(vaultDir, 'd.md'), '# D\n\n[[b]]\n');
    assert.deepEqual(
      await nodesOf(await local(app)),
      ['a.md', 'b.md'],
      '局部图同样吃缓存，不该因为换 scope 就重扫',
    );

    cache.invalidate(vaultId);
    assert.deepEqual(await nodesOf(await local(app)), ['a.md', 'b.md', 'd.md']);
  });

  it('vault 不存在时先 404，不碰缓存', async () => {
    const app = appWith(new GraphCache());
    const res = await app.request('/api/graph/does-not-exist');
    assert.equal(res.status, 404);
  });

  // VaultWatcher 的就绪判定（isReady）：watch() 是 fire-and-forget 的，初次扫描
  // 完成前与监听失败后都不会有 tree-changed。此时缓存没有失效信号可用，必须
  // 退回「每次都重扫」——否则「没有信号」会被当成「内容没变」，图谱停在旧数据上。
  it('监听未就绪 → 全量图不吃缓存，每次请求都重扫', async () => {
    const cache = new GraphCache();
    let ready = false;
    const app = appWith(cache, () => ready);

    const before = await nodesOf(await app.request(`/api/graph/${vaultId}`));
    writeFileSync(join(vaultDir, 'not-ready-1.md'), '# 1\n\n[[a]]\n');
    assert.deepEqual(
      await nodesOf(await app.request(`/api/graph/${vaultId}`)),
      [...before, 'not-ready-1.md'].sort(),
      '未就绪 → 不缓存 → 刚落盘的文件立刻可见',
    );

    writeFileSync(join(vaultDir, 'not-ready-2.md'), '# 2\n\n[[a]]\n');
    assert.deepEqual(
      await nodesOf(await app.request(`/api/graph/${vaultId}`)),
      [...before, 'not-ready-1.md', 'not-ready-2.md'].sort(),
    );

    // 就绪后缓存接管：与「全量图命中缓存」一条同一判据（新文件在失效前不可见）
    ready = true;
    const snapshot = await nodesOf(await app.request(`/api/graph/${vaultId}`));
    writeFileSync(join(vaultDir, 'not-ready-3.md'), '# 3\n\n[[a]]\n');
    assert.deepEqual(
      await nodesOf(await app.request(`/api/graph/${vaultId}`)),
      snapshot,
      '就绪后恢复缓存行为（信号在了，才敢吃缓存）',
    );

    cache.invalidate(vaultId);
    assert.ok((await nodesOf(await app.request(`/api/graph/${vaultId}`))).includes('not-ready-3.md'));
  });

  it('监听未就绪 → 局部图同样每次都重扫', async () => {
    const cache = new GraphCache();
    const app = appWith(cache, () => false);
    const local = () =>
      app.request(`/api/graph/${vaultId}/local?scope=file&path=local-not-ready.md&depth=1`);

    // 先把圆心落下并请求一次（若错误地缓存了，缓存的就是此刻的快照）
    writeFileSync(join(vaultDir, 'local-not-ready.md'), '# L\n\n[[a]]\n');
    assert.deepEqual(await nodesOf(await local()), ['a.md', 'local-not-ready.md']);

    // 新邻居（反向链接圆心）落盘后，邻域必须立刻长大
    writeFileSync(join(vaultDir, 'local-not-ready-2.md'), '# L2\n\n[[local-not-ready]]\n');
    assert.deepEqual(
      await nodesOf(await local()),
      ['a.md', 'local-not-ready-2.md', 'local-not-ready.md'],
      '未就绪 → 局部图也不该停在旧快照上',
    );
  });
});
