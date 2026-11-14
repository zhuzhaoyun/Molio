import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GraphCache } from '../../src/core/graph-cache.js';
import type { GraphData } from '@molio/contracts';

/**
 * GraphCache 单测。
 *
 * 背景（性能）：buildGraph 是整库扫描，实测移动盘大库（70k 文件 / 6.5k md）
 * 单次要 5.2s；而打开图谱 / 每次切 scope 都在调它。缓存的全量图由路由直接
 * 过滤成局部图，所以「同一 vault 连续多次请求只算一次」是这套优化的核心不变量。
 *
 * 缓存语义与 TreeCache 共用 core/vault-cache.ts（single-flight、构建中途失效、
 * TTL、LRU 在那里有完整用例）；这里钉的是图谱这条路径确实接上了这套语义。
 */

const emptyGraph: GraphData = { nodes: [], edges: [], deadLinks: [] };

describe('GraphCache', () => {
  it('同一 vault 多次取用只构建一次', async () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = async () => {
      builds++;
      return emptyGraph;
    };

    await cache.getOrBuild('v1', build);
    await cache.getOrBuild('v1', build);
    await cache.getOrBuild('v1', build);

    assert.equal(builds, 1);
  });

  it('冷缓存上的并发请求共享同一次构建（single-flight）', async () => {
    const cache = new GraphCache();
    let builds = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const build = async (): Promise<GraphData> => {
      builds++;
      await gate;
      return emptyGraph;
    };

    const p1 = cache.getOrBuild('v1', build);
    const p2 = cache.getOrBuild('v1', build);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(builds, 1, '并发窗口内只允许一次整库扫描');
    assert.equal(r1, r2);
  });

  it('不同 vault 各自缓存', async () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = async () => {
      builds++;
      return emptyGraph;
    };

    await cache.getOrBuild('v1', build);
    await cache.getOrBuild('v2', build);
    await cache.getOrBuild('v1', build);

    assert.equal(builds, 2);
  });

  it('invalidate 后同一 vault 重新构建（tree-changed 的失效路径）', async () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = async () => {
      builds++;
      return emptyGraph;
    };

    await cache.getOrBuild('v1', build);
    cache.invalidate('v1');
    await cache.getOrBuild('v1', build);

    assert.equal(builds, 2);
  });

  it('invalidate 其他 vault 不影响本 vault 的命中', async () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = async () => {
      builds++;
      return emptyGraph;
    };

    await cache.getOrBuild('v1', build);
    cache.invalidate('v2');
    await cache.getOrBuild('v1', build);

    assert.equal(builds, 1);
  });

  it('TTL 过期后重建（watcher 没建立监听时的兜底，不让缓存无限期陈旧）', async () => {
    let clock = 1_000;
    const cache = new GraphCache(4, 500, () => clock);
    let builds = 0;
    const build = async () => {
      builds++;
      return emptyGraph;
    };

    await cache.getOrBuild('v1', build);
    clock += 499; // 未过期
    await cache.getOrBuild('v1', build);
    assert.equal(builds, 1);

    clock += 2; // 过期
    await cache.getOrBuild('v1', build);
    assert.equal(builds, 2);
  });

  it('超过容量上限时按 LRU 淘汰最久未用的 vault', async () => {
    const cache = new GraphCache(2);
    const built = new Set<string>();
    const buildFor = (id: string) => async () => {
      built.add(id);
      return emptyGraph;
    };

    await cache.getOrBuild('v1', buildFor('v1'));
    await cache.getOrBuild('v2', buildFor('v2'));
    await cache.getOrBuild('v1', buildFor('v1')); // v1 变为最近使用 → v2 成为最老的
    await cache.getOrBuild('v3', buildFor('v3')); // 触发淘汰 v2

    assert.deepEqual([...built], ['v1', 'v2', 'v3']);

    built.clear();
    await cache.getOrBuild('v1', buildFor('v1')); // 仍命中
    assert.deepEqual([...built], [], 'v1 不该被淘汰');

    await cache.getOrBuild('v2', buildFor('v2')); // v2 已被淘汰 → 重建
    assert.deepEqual([...built], ['v2']);
  });

  it('构建抛错时不写缓存，下次仍会重试', async () => {
    const cache = new GraphCache();
    let attempts = 0;
    const build = async () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return emptyGraph;
    };

    await assert.rejects(cache.getOrBuild('v1', build), /boom/);
    await cache.getOrBuild('v1', build);
    assert.equal(attempts, 2, '失败不该被记住');
  });
});
