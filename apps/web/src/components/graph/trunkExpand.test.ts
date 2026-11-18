import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphData, GraphNode } from '@molio/contracts';
import { buildTrunkScene, type TrunkScene } from './trunkScene.ts';
import {
  buildExpansion,
  splitBatches,
  computeMiniSim,
  centroidOf,
  translatePositions,
  matchExpansionsOnRefresh,
} from './trunkExpand.ts';
import { collideRadiusValue } from './engine/graphUtils.ts';

/**
 * trunk 展开纯逻辑的行为约定测试（设计 docs/2026-11-18-graph-h2-expand-interaction-design.md
 * §4.1 + 代拍 F/L/O）：spoke 去重带权、分批口径、mini-sim 兜底、质心平移、刷新身份重匹配。
 */

function md(key: string, linkCount: number): GraphNode {
  return { key, label: key.replace(/\.md$/, ''), path: key, linkCount, nodeType: 'document' };
}

function fixtureGraph(): GraphData {
  const nodes = [
    md('topic-a/a1.md', 4),
    md('topic-a/a2.md', 3),
    md('topic-a/a3.md', 2),
    md('topic-a/a4.md', 2),
    md('topic-a/a5.md', 2),
    md('topic-a/a6.md', 1),
    md('topic-b/b1.md', 3),
    md('topic-b/b2.md', 1),
    md('topic-b/b3.md', 1),
    md('topic-b/b4.md', 1),
    md('总目录.md', 3),
  ];
  const edges = [
    { source: 'topic-a/a1.md', target: 'topic-a/a2.md' },
    { source: 'topic-a/a2.md', target: 'topic-a/a3.md' },
    { source: 'topic-a/a3.md', target: 'topic-a/a4.md' },
    { source: 'topic-a/a4.md', target: 'topic-a/a5.md' },
    { source: 'topic-a/a5.md', target: 'topic-a/a6.md' },
    { source: 'topic-a/a1.md', target: '总目录.md' },
    { source: 'topic-a/a2.md', target: '总目录.md' },
    { source: 'topic-a/a1.md', target: 'topic-b/b1.md' },
    { source: 'topic-a/a1.md', target: 'topic-b/b2.md' },
    { source: 'topic-a/a2.md', target: 'topic-b/b1.md' },
    { source: 'topic-b/b1.md', target: '总目录.md' },
  ];
  return {
    nodes,
    edges,
    deadLinks: [],
    communities: {
      clusters: [
        {
          id: 'c1',
          label: '主题甲',
          memberIds: ['topic-a/a1.md', 'topic-a/a2.md', 'topic-a/a3.md', 'topic-a/a4.md', 'topic-a/a5.md', 'topic-a/a6.md'],
          size: 6,
        },
        {
          id: 'c2',
          label: '主题乙',
          memberIds: ['topic-b/b1.md', 'topic-b/b2.md', 'topic-b/b3.md', 'topic-b/b4.md'],
          size: 4,
        },
      ],
      hubIds: ['总目录.md'],
      links: [
        { source: 'c1', target: '总目录.md', weight: 2 },
        { source: 'c2', target: '总目录.md', weight: 1 },
        { source: 'c1', target: 'c2', weight: 3 },
      ],
      crumbCount: 0,
      quality: 'ok',
    },
  } as unknown as GraphData;
}

const A_KEYS = ['topic-a/a1.md', 'topic-a/a2.md', 'topic-a/a3.md', 'topic-a/a4.md', 'topic-a/a5.md', 'topic-a/a6.md'];

function edgeSet(edges: Array<{ source: string; target: string; weight?: number }>): Set<string> {
  return new Set(edges.map((e) => (e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`)));
}

describe('buildExpansion（载荷与 spoke，代拍 L）', () => {
  const graph = fixtureGraph();
  const scene = buildTrunkScene(graph)!;

  it('成员节点/顺序：linkCount 降序，同度按 key 稳定', () => {
    const payload = buildExpansion(scene, graph, 'c1', new Set())!;
    assert.equal(payload.clusterId, 'c1');
    assert.equal(payload.memberNodes.length, 6);
    assert.deepEqual(payload.memberOrder, A_KEYS);
    assert.ok(payload.memberNodes.every((n) => n.key.startsWith('topic-a/')));
  });

  it('对端是收起簇 → spoke 按 (成员,团) 对去重一条、weight=真实边数；无逐边', () => {
    const payload = buildExpansion(scene, graph, 'c1', new Set())!;
    const spokes = payload.edges.filter((e) => e.weight !== undefined);
    assert.equal(spokes.length, 2);
    const s1 = spokes.find((e) => e.source === 'topic-a/a1.md')!;
    assert.equal(s1.target, 'c2');
    assert.equal(s1.weight, 2); // a1→b1、a1→b2
    const s2 = spokes.find((e) => e.source === 'topic-a/a2.md')!;
    assert.equal(s2.target, 'c2');
    assert.equal(s2.weight, 1);
  });

  it('簇内真实边 + 成员↔hub 真实边（无 weight）', () => {
    const payload = buildExpansion(scene, graph, 'c1', new Set())!;
    const real = payload.edges.filter((e) => e.weight === undefined);
    // 5 簇内 + 2 到 hub
    assert.equal(real.length, 7);
    assert.ok(edgeSet(real).has('topic-a/a1.md|总目录.md'));
    assert.ok(edgeSet(real).has('topic-a/a5.md|topic-a/a6.md'));
  });

  it('对端簇已展开 → 还原为真实成员边（不再 spoke）', () => {
    const payload = buildExpansion(scene, graph, 'c1', new Set(['c2']))!;
    assert.equal(payload.edges.filter((e) => e.weight !== undefined).length, 0);
    assert.ok(edgeSet(payload.edges).has('topic-a/a1.md|topic-b/b1.md'));
    assert.ok(edgeSet(payload.edges).has('topic-a/a2.md|topic-b/b1.md'));
  });

  it('簇不存在 → null', () => {
    assert.equal(buildExpansion(scene, graph, 'cX', new Set()), null);
  });
});

describe('splitBatches（代拍 F：首批 300，后续块 500）', () => {
  it('400 项 → [300, 100]', () => {
    const items = Array.from({ length: 400 }, (_, i) => `k${i}`);
    assert.deepEqual(splitBatches(items).map((b) => b.length), [300, 100]);
  });
  it('1000 项 → [300, 500, 200]', () => {
    const items = Array.from({ length: 1000 }, (_, i) => `k${i}`);
    assert.deepEqual(splitBatches(items).map((b) => b.length), [300, 500, 200]);
  });
  it('≤300 项 → 单批原样（保持顺序）', () => {
    const items = ['a', 'b', 'c'];
    assert.deepEqual(splitBatches(items), [['a', 'b', 'c']]);
  });
});

describe('computeMiniSim（质心锚 radial + 局部力兜底）', () => {
  const graph = fixtureGraph();
  const scene = buildTrunkScene(graph)!;
  const payload = buildExpansion(scene, graph, 'c1', new Set())!;

  it('全部成员有落位：与质心距离 ∈ (0, 2000)', () => {
    const pos = computeMiniSim(payload.memberOrder, payload.edges, { x: 100, y: -50 });
    assert.equal(pos.size, 6);
    for (const [key, p] of pos) {
      const dist = Math.hypot(p.x - 100, p.y + 50);
      assert.ok(dist > 0, `${key} 不应落在质心上`);
      assert.ok(dist < 2000, `${key} 距质心 ${dist} 超界`);
    }
  });

  it('init 已放置成员被钉住（±0.5），新成员围绕生长', () => {
    const init = new Map([
      ['topic-a/a1.md', { x: 80, y: -30 }],
      ['topic-a/a2.md', { x: 120, y: -70 }],
    ]);
    const pos = computeMiniSim(payload.memberOrder, payload.edges, { x: 100, y: -50 }, init);
    assert.ok(Math.abs(pos.get('topic-a/a1.md')!.x - 80) < 0.5);
    assert.ok(Math.abs(pos.get('topic-a/a1.md')!.y + 30) < 0.5);
    assert.ok(Math.abs(pos.get('topic-a/a2.md')!.x - 120) < 0.5);
    assert.ok(pos.has('topic-a/a6.md'));
  });
});

describe('centroid / translate', () => {
  it('centroidOf 取均值', () => {
    const c = centroidOf(new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: -20 }]]));
    assert.deepEqual(c, { x: 5, y: -10 });
  });
  it('translatePositions 按向量平移且不改源', () => {
    const src = new Map([['a', { x: 0, y: 0 }], ['b', { x: 10, y: 4 }]]);
    const out = translatePositions(src, { x: 1, y: 2 }, { x: 11, y: -8 });
    assert.deepEqual(out.get('a'), { x: 10, y: -10 });
    assert.deepEqual(out.get('b'), { x: 20, y: -6 });
    assert.deepEqual(src.get('a'), { x: 0, y: 0 });
  });
});

describe('matchExpansionsOnRefresh（代拍 O：最小成员 key 身份 + ≥80% 重合）', () => {
  function sceneWith(clusters: Array<{ id: string; memberIds: string[] }>): TrunkScene {
    return {
      hubs: [{ key: '总目录.md', label: '总目录', path: '总目录.md', linkCount: 3 }],
      clusters: clusters.map((c) => ({ id: c.id, label: c.id, size: c.memberIds.length, memberIds: c.memberIds })),
      links: [],
      crumbCount: 0,
      quality: 'ok',
    };
  }
  const prev = sceneWith([{ id: 'c1', memberIds: A_KEYS }, { id: 'c2', memberIds: ['topic-b/b1.md'] }]);

  it('同成员重编号（c1→c2）→ keep 映射', () => {
    const next = sceneWith([{ id: 'c1', memberIds: ['0-新/b0.md'] }, { id: 'c2', memberIds: A_KEYS }]);
    const m = matchExpansionsOnRefresh(prev, next, ['c1']);
    assert.deepEqual(m.keep, [{ oldId: 'c1', newId: 'c2' }]);
    assert.deepEqual(m.drop, []);
  });

  it('成员重合 <80% → drop（展开态不能挂到面目全非的簇上）', () => {
    const drifted = ['topic-a/a1.md', 'topic-a/a2.md', 'topic-a/a3.md', 'topic-a/a4.md', '新/x1.md', '新/x2.md'];
    const next = sceneWith([{ id: 'c1', memberIds: drifted }]);
    const m = matchExpansionsOnRefresh(prev, next, ['c1']);
    assert.deepEqual(m.keep, []);
    assert.deepEqual(m.drop, ['c1']);
  });

  it('min key 相同但成员大换血（重合 <80%）→ drop', () => {
    const next = sceneWith([{ id: 'c1', memberIds: ['topic-a/a1.md', '新/y1.md', '新/y2.md', '新/y3.md', '新/y4.md', '新/y5.md'] }]);
    const m = matchExpansionsOnRefresh(prev, next, ['c1']);
    assert.deepEqual(m.drop, ['c1']);
  });

  it('id 消失于新 scene → drop；阈值参数可调（0.67 重合：默认 0.8 drop、0.5 keep）', () => {
    const next = sceneWith([{ id: 'c9', memberIds: A_KEYS }]);
    const m = matchExpansionsOnRefresh(prev, next, ['c1', 'c2']);
    assert.deepEqual(m.keep, [{ oldId: 'c1', newId: 'c9' }]);
    assert.deepEqual(m.drop, ['c2']);
    const drifted = ['topic-a/a1.md', 'topic-a/a2.md', 'topic-a/a3.md', 'topic-a/a4.md', '新/x1.md', '新/x2.md'];
    const next2 = sceneWith([{ id: 'c1', memberIds: drifted }]);
    assert.deepEqual(matchExpansionsOnRefresh(prev, next2, ['c1'], 0.5).keep, [{ oldId: 'c1', newId: 'c1' }]);
  });
});

describe('collideRadiusValue（与引擎 collideRadius 同式，单一来源）', () => {
  it('radius×5+4，封顶 100', () => {
    assert.equal(collideRadiusValue(10), 54);
    assert.equal(collideRadiusValue(1000), 100);
  });
});
