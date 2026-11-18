import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphData, GraphNode, GraphCommunities } from '@molio/contracts';
import {
  buildTrunkScene,
  resolveTrunkView,
  trunkBlobRadius,
  trunkEdgeWidth,
  trunkClusterColor,
  trunkExportMeta,
} from './trunkScene.ts';
import { NODE_TYPE_COLORS } from './types.ts';

/** trunkScene 纯模块的行为约定测试（设计 docs/2026-11-15-graph-trunk-view-design.md §4.2 + roadmap H1 代拍）。 */

function md(key: string, opts: { folder?: string; dead?: boolean } = {}): GraphNode {
  const path = opts.folder ? `${opts.folder}/${key}` : key;
  return {
    key: path,
    label: key.replace(/\.md$/, ''),
    path,
    linkCount: 0,
    nodeType: 'document',
    ...(opts.dead ? { deadLink: true } : {}),
  };
}

function communitiesFixture(): GraphCommunities {
  return {
    clusters: [
      { id: 'c1', label: '主题甲', memberIds: ['topic-a/a1.md', 'topic-a/a2.md'], size: 2 },
      { id: 'c2', label: '主题乙', memberIds: ['topic-b/b1.md', 'topic-b/b2.md'], size: 2 },
    ],
    hubIds: ['总目录.md'],
    links: [
      { source: 'c1', target: '总目录.md', weight: 2 },
      { source: 'c2', target: 'c1', weight: 3 },
    ],
    crumbCount: 5,
    quality: 'ok',
  };
}

function graphFixture(): GraphData {
  return {
    nodes: [
      md('总目录.md'),
      ...['a1.md', 'a2.md'].map((k) => md(k, { folder: 'topic-a' })),
      ...['b1.md', 'b2.md'].map((k) => md(k, { folder: 'topic-b' })),
      md('__dead__x.md', { dead: true }),
      md('lonely.md'),
    ],
    edges: [
      { source: 'topic-a/a1.md', target: 'topic-a/a2.md' },
      { source: 'topic-b/b1.md', target: 'topic-b/b2.md' },
      { source: 'topic-a/a1.md', target: '总目录.md' },
      { source: 'topic-a/a2.md', target: '总目录.md' },
      { source: 'topic-b/b2.md', target: '总目录.md' },
      { source: '总目录.md', target: '__dead__x.md' }, // 幻影边：不计 hub 度数
    ],
    deadLinks: [],
    communities: communitiesFixture(),
  };
}

describe('buildTrunkScene', () => {
  it('① 派生 hubs（真实度数）/clusters/links/crumbCount/quality', () => {
    const s = buildTrunkScene(graphFixture())!;
    assert.ok(s);
    assert.deepEqual(s.hubs, [
      { key: '总目录.md', label: '总目录', path: '总目录.md', nodeType: 'document', linkCount: 3 },
    ], 'hub 度数=3 条真实边（幻影边剔除）');
    assert.deepEqual(s.clusters.map((c) => c.id), ['c1', 'c2']);
    assert.deepEqual(s.clusters[0]!.memberIds, ['topic-a/a1.md', 'topic-a/a2.md']);
    assert.deepEqual(s.links, [
      { source: 'c1', target: '总目录.md', weight: 2 },
      { source: 'c2', target: 'c1', weight: 3 },
    ], '聚合边原样透传（端点序由 daemon 规范化）');
    assert.equal(s.crumbCount, 5);
    assert.equal(s.quality, 'ok');
  });

  it('② communities 缺失或 clusters 空 → null', () => {
    const noComm = { ...graphFixture(), communities: undefined };
    assert.equal(buildTrunkScene(noComm), null);
    const emptyClusters = {
      ...graphFixture(),
      communities: { ...communitiesFixture(), clusters: [] },
    };
    assert.equal(buildTrunkScene(emptyClusters), null);
  });

  it('③ hub 度数剔死链幻影边（daemon 同口径防御）', () => {
    const s = buildTrunkScene(graphFixture())!;
    assert.equal(s.hubs[0]!.linkCount, 3, '总目录 4 条边中 1 条指向幻影 → 度数 3');
  });

  it('③b 引用不存在节点的边不计度数（防御：不抛错）', () => {
    const g = graphFixture();
    g.edges.push({ source: '总目录.md', target: 'nope.md' });
    const s = buildTrunkScene(g)!;
    assert.equal(s.hubs[0]!.linkCount, 3);
  });
});

describe('resolveTrunkView', () => {
  const base = {
    scope: null,
    scene: buildTrunkScene(graphFixture()),
    globalView: 'trunk' as const,
    showOrphans: true,
    showDeadLinks: true,
    visibleTypes: [],
    companion: false,
  };

  it('④a 全条件满足 → ok/active', () => {
    const r = resolveTrunkView(base);
    assert.deepEqual(r, { active: true, reason: 'ok' });
  });

  it('④b 用户关了枝干 → off', () => {
    const r = resolveTrunkView({ ...base, globalView: 'full' });
    assert.deepEqual(r, { active: false, reason: 'off' });
  });

  it('④c scope 非 null / companion / clusters 空 → no-communities', () => {
    assert.deepEqual(resolveTrunkView({ ...base, scope: { type: 'file', path: 'a.md' } }), { active: false, reason: 'no-communities' });
    assert.deepEqual(resolveTrunkView({ ...base, companion: true }), { active: false, reason: 'no-communities' });
    assert.deepEqual(resolveTrunkView({ ...base, scene: null }), { active: false, reason: 'no-communities' });
  });

  it('④d 筛选偏离默认（三开关任一）→ filters', () => {
    assert.deepEqual(resolveTrunkView({ ...base, showOrphans: false }), { active: false, reason: 'filters' });
    assert.deepEqual(resolveTrunkView({ ...base, showDeadLinks: false }), { active: false, reason: 'filters' });
    assert.deepEqual(resolveTrunkView({ ...base, visibleTypes: ['document'] }), { active: false, reason: 'filters' });
  });

  it('④e reason 优先级：off 与 filters 同时成立 → filters 优先（用户看得到为什么）', () => {
    const r = resolveTrunkView({ ...base, globalView: 'full', showOrphans: false });
    assert.deepEqual(r, { active: false, reason: 'filters' });
  });
});

describe('渲染公式', () => {
  it('⑤a trunkBlobRadius：size 324 → 22（4 + √324）', () => {
    assert.equal(trunkBlobRadius(324), 22);
    assert.equal(trunkBlobRadius(1), 5);
  });

  it('⑤b trunkEdgeWidth：weight 1 → 1；weight 58 → 1+log2(58)', () => {
    assert.equal(trunkEdgeWidth(1), 1);
    assert.ok(Math.abs(trunkEdgeWidth(58) - (1 + Math.log2(58))) < 1e-9);
    assert.equal(trunkEdgeWidth(0), 1, 'weight<1 钳到 1');
  });

  it('⑤c trunkClusterColor：确定性 + 落在调色板内', () => {
    const palette = [...new Set(Object.values(NODE_TYPE_COLORS))];
    for (const id of ['c1', 'c2', 'c3', 'c10', 'c40']) {
      const c1 = trunkClusterColor(id);
      const c2 = trunkClusterColor(id);
      assert.equal(c1, c2, `${id} 两次同色`);
      assert.ok(palette.includes(c1), `${id} 色 ${c1} ∈ 调色板`);
    }
  });

  it('⑥ trunkExportMeta：trunk 态出图统计描述画面上的 trunk 对象（终审 Important-3）', () => {
    const s = buildTrunkScene(graphFixture())!; // 2 簇 1 hub
    assert.equal(trunkExportMeta(s, '簇', '枢纽'), '簇 2 · 枢纽 1');
    const noHub = { ...s, hubs: [] };
    assert.equal(trunkExportMeta(noHub, '簇', '枢纽'), '簇 2');
    const noCluster = { ...s, clusters: [] };
    assert.equal(trunkExportMeta(noCluster, '簇', '枢纽'), '枢纽 1');
  });
});
