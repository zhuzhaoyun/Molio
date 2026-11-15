import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphData, GraphEdge, GraphNode } from '@molio/contracts';
import { detectCommunities } from '../../src/core/graph-communities.js';

/**
 * core/graph-communities.ts 的行为约定测试（设计 docs/2026-11-15-graph-trunk-view-design.md §4.1）。
 *
 * 全部用 GraphData 字面量构造（纯函数不碰 fs）。fixture 全用「团（clique）」形状：
 * LPA 对团的划分是稳定解，跨团单边（4:1 票数比）翻不动多数派——断言才可依赖。
 */

function md(key: string, opts: { folder?: string; dead?: boolean; type?: string } = {}): GraphNode {
  const path = opts.folder ? `${opts.folder}/${key}` : key;
  return {
    key: path,
    label: key.replace(/\.md$/, ''),
    path,
    linkCount: 0,
    nodeType: opts.type ?? 'document',
    ...(opts.dead ? { deadLink: true } : {}),
  };
}

/** 团：keys 内两两连边（无序对去重） */
function cliqueEdges(keys: string[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      edges.push({ source: keys[i]!, target: keys[j]! });
    }
  }
  return edges;
}

function graph(nodes: GraphNode[], edges: GraphEdge[]): GraphData {
  return { nodes, edges, deadLinks: [] };
}

/** 两个不相连的团（可指定不同文件夹），返回节点与边 */
function twoCliques(folderA: string, keysA: string[], folderB: string | null, keysB: string[]) {
  const nodes = [
    ...keysA.map((k) => md(k, { folder: folderA })),
    ...(folderB === null ? [] : keysB.map((k) => md(k, { folder: folderB }))),
  ];
  const edges = [...cliqueEdges(keysA.map((k) => `${folderA}/${k}`))];
  if (folderB !== null) edges.push(...cliqueEdges(keysB.map((k) => `${folderB}/${k}`)));
  return { nodes, edges };
}

describe('detectCommunities', () => {
  it('1. 确定性：同一图跑两次结果逐字段相等', () => {
    const { nodes, edges } = twoCliques('topic-a', ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'], 'topic-b', ['b1.md', 'b2.md', 'b3.md', 'b4.md', 'b5.md']);
    edges.push({ source: 'topic-a/a3.md', target: 'topic-b/b3.md' });
    const g = graph(nodes, edges);
    assert.deepEqual(detectCommunities(g, { minNodes: 0 }), detectCommunities(g, { minNodes: 0 }));
  });

  it('2. 两个 5 团 + 1 跨团边：两个簇、成员各归各组、聚合边 weight=1', () => {
    const keysA = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'];
    const keysB = ['b1.md', 'b2.md', 'b3.md', 'b4.md', 'b5.md'];
    const { nodes, edges } = twoCliques('topic-a', keysA, 'topic-b', keysB);
    edges.push({ source: 'topic-a/a3.md', target: 'topic-b/b3.md' });
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.equal(c.clusters.length, 2);
    assert.deepEqual(c.clusters.map((x) => x.id), ['c1', 'c2']);
    assert.deepEqual(c.clusters[0]!.memberIds, keysA.map((k) => `topic-a/${k}`));
    assert.deepEqual(c.clusters[1]!.memberIds, keysB.map((k) => `topic-b/${k}`));
    assert.deepEqual(c.clusters.map((x) => x.size), [5, 5]);
    assert.deepEqual(c.clusters.map((x) => x.label), ['topic-a', 'topic-b']);
    assert.deepEqual(c.links, [{ source: 'c1', target: 'c2', weight: 1 }]);
    assert.deepEqual(c.hubIds, []);
    assert.equal(c.crumbCount, 0);
    assert.equal(c.quality, 'ok');
  });

  it('3. hub：度数 ≥ hubThreshold 的节点进 hubIds、不进 memberIds，hub-簇聚合边出现', () => {
    // 星形：hub.md 连 s1..s4（hub 度 4 ≥ 3；簇去 hub 后 4 成员 ≥ clusterMinSize 3）
    const nodes = [md('hub.md'), md('s1.md'), md('s2.md'), md('s3.md'), md('s4.md')];
    const edges = ['s1.md', 's2.md', 's3.md', 's4.md'].map((s) => ({ source: 'hub.md', target: s }));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0, hubThreshold: 3, clusterMinSize: 3 });

    assert.deepEqual(c.hubIds, ['hub.md']);
    assert.equal(c.clusters.length, 1);
    assert.deepEqual(c.clusters[0]!.memberIds, ['s1.md', 's2.md', 's3.md', 's4.md']);
    // 'c1' < 'hub.md'（端点按字典序规范化）
    assert.deepEqual(c.links, [{ source: 'c1', target: 'hub.md', weight: 4 }]);
  });

  it('4. 口径：死链幻影与孤立节点不进簇/聚合边，计入 crumbCount', () => {
    const keysA = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'];
    const { nodes, edges } = twoCliques('topic-a', keysA, null, []);
    nodes.push(md('__dead__ghost.md', { dead: true }), md('lonely.md'));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    const allMembers = c.clusters.flatMap((x) => x.memberIds);
    assert.ok(!allMembers.includes('__dead__ghost.md'));
    assert.ok(!allMembers.includes('lonely.md'));
    for (const l of c.links) {
      assert.ok(l.source !== '__dead__ghost.md' && l.target !== '__dead__ghost.md');
      assert.ok(l.source !== 'lonely.md' && l.target !== 'lonely.md');
    }
    assert.equal(c.clusters.length, 1);
    assert.equal(c.crumbCount, 2);
  });

  it('5. 小簇（<clusterMinSize 默认 5）整簇计碎屑，不出 clusters', () => {
    // 4 团（碎屑）+ 5 团（保留）
    const keysSmall = ['n1.md', 'n2.md', 'n3.md', 'n4.md'];
    const { nodes, edges } = twoCliques('topic-small', keysSmall, 'topic-big', ['m1.md', 'm2.md', 'm3.md', 'm4.md', 'm5.md']);
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.equal(c.clusters.length, 1);
    assert.equal(c.clusters[0]!.label, 'topic-big');
    assert.equal(c.crumbCount, 4);
  });

  it('6. minNodes 门：图小于阈值 → 三字段全空，crumbCount 仍正确', () => {
    const keys = ['k1.md', 'k2.md', 'k3.md', 'k4.md', 'k5.md', 'k6.md'];
    const { nodes, edges } = twoCliques('topic-a', keys, null, []);
    const c = detectCommunities(graph(nodes, edges), { minNodes: 10 });
    assert.deepEqual(c.clusters, []);
    assert.deepEqual(c.hubIds, []);
    assert.deepEqual(c.links, []);
    assert.equal(c.crumbCount, 0);
    assert.equal(c.quality, 'ok');
  });

  it('7. 退化：单一巨团吞掉全部非 hub 节点 → quality degenerate', () => {
    const keys = Array.from({ length: 12 }, (_, i) => `x${i + 1}.md`);
    const c = detectCommunities(graph(keys.map((k) => md(k)), cliqueEdges(keys)), { minNodes: 0 });
    assert.equal(c.clusters.length, 1);
    assert.equal(c.clusters[0]!.size, 12);
    assert.equal(c.quality, 'degenerate');
  });

  it('8. 命名：同文件夹两个不相连团 → 同名簇全部带 ·size 后缀', () => {
    const { nodes, edges } = twoCliques('topic-a', ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'], null, []);
    const keysB = ['a6.md', 'a7.md', 'a8.md', 'a9.md', 'a10.md'];
    nodes.push(...keysB.map((k) => md(k, { folder: 'topic-a' })));
    edges.push(...cliqueEdges(keysB.map((k) => `topic-a/${k}`)));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.equal(c.clusters.length, 2);
    // 不相连分量 → 两个独立簇；folder 众数同名 → 全部追加 ·size 消歧
    assert.deepEqual(c.clusters.map((x) => x.label).sort(), ['topic-a·5', 'topic-a·5']);
  });

  it('9. 空图与单孤立节点：不抛错，crumbCount 正确', () => {
    const empty = detectCommunities(graph([], []));
    assert.deepEqual(empty.clusters, []);
    assert.equal(empty.crumbCount, 0);
    assert.equal(empty.quality, 'ok');

    const single = detectCommunities(graph([md('x.md')], []));
    assert.deepEqual(single.clusters, []);
    assert.equal(single.crumbCount, 1);
    assert.equal(single.quality, 'ok');
  });
});
