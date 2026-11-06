import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GraphCache } from '../../src/core/graph-cache.js';
import type { GraphData } from '@molio/contracts';

/**
 * GraphCache 单测。
 *
 * 背景（性能）：buildGraph 是同步整库扫描，实测移动盘大库（70k 文件 / 6.5k md）
 * 单次要 5.2s，且期间阻塞 daemon 事件循环；而打开图谱 / 每次切 scope 都在调它。
 * 缓存的全量图由路由直接过滤成局部图，所以「同一 vault 连续多次请求只算一次」
 * 是这套优化的核心不变量。
 */

const emptyGraph: GraphData = { nodes: [], edges: [], deadLinks: [] };

describe('GraphCache', () => {
  it('同一 vault 多次取用只构建一次', () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = () => {
      builds++;
      return emptyGraph;
    };

    cache.getOrBuild('v1', build);
    cache.getOrBuild('v1', build);
    cache.getOrBuild('v1', build);

    assert.equal(builds, 1);
  });

  it('不同 vault 各自缓存', () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = () => {
      builds++;
      return emptyGraph;
    };

    cache.getOrBuild('v1', build);
    cache.getOrBuild('v2', build);
    cache.getOrBuild('v1', build);

    assert.equal(builds, 2);
  });

  it('invalidate 后同一 vault 重新构建（tree-changed 的失效路径）', () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = () => {
      builds++;
      return emptyGraph;
    };

    cache.getOrBuild('v1', build);
    cache.invalidate('v1');
    cache.getOrBuild('v1', build);

    assert.equal(builds, 2);
  });

  it('invalidate 其他 vault 不影响本 vault 的命中', () => {
    const cache = new GraphCache();
    let builds = 0;
    const build = () => {
      builds++;
      return emptyGraph;
    };

    cache.getOrBuild('v1', build);
    cache.invalidate('v2');
    cache.getOrBuild('v1', build);

    assert.equal(builds, 1);
  });

  it('TTL 过期后重建（watcher 没建立监听时的兜底，不让缓存无限期陈旧）', () => {
    let clock = 1_000;
    const cache = new GraphCache(4, 500, () => clock);
    let builds = 0;
    const build = () => {
      builds++;
      return emptyGraph;
    };

    cache.getOrBuild('v1', build);
    clock += 499; // 未过期
    cache.getOrBuild('v1', build);
    assert.equal(builds, 1);

    clock += 2; // 过期
    cache.getOrBuild('v1', build);
    assert.equal(builds, 2);
  });

  it('超过容量上限时按 LRU 淘汰最久未用的 vault', () => {
    const cache = new GraphCache(2);
    const built = new Set<string>();
    const buildFor = (id: string) => () => {
      built.add(id);
      return emptyGraph;
    };

    cache.getOrBuild('v1', buildFor('v1'));
    cache.getOrBuild('v2', buildFor('v2'));
    cache.getOrBuild('v1', buildFor('v1')); // v1 变为最近使用 → v2 成为最老的
    cache.getOrBuild('v3', buildFor('v3')); // 触发淘汰 v2

    assert.deepEqual([...built], ['v1', 'v2', 'v3']);

    built.clear();
    cache.getOrBuild('v1', buildFor('v1')); // 仍命中
    assert.deepEqual([...built], [], 'v1 不该被淘汰');

    cache.getOrBuild('v2', buildFor('v2')); // v2 已被淘汰 → 重建
    assert.deepEqual([...built], ['v2']);
  });

  it('构建抛错时不写缓存，下次仍会重试', () => {
    const cache = new GraphCache();
    let attempts = 0;
    const build = () => {
      attempts++;
      if (attempts === 1) throw new Error('boom');
      return emptyGraph;
    };

    assert.throws(() => cache.getOrBuild('v1', build), /boom/);
    assert.doesNotThrow(() => cache.getOrBuild('v1', build));
    assert.equal(attempts, 2, '失败不该被记住');
  });
});
