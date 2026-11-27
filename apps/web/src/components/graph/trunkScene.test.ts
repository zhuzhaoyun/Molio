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
  layoutChildClusters,
  budgetChildLabels,
  blendChildPlacements,
  findClusterDeep,
  flattenSearchableClusters,
  topIdOf,
  planChildCorrections,
  type TrunkCluster,
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

  it('⑦ trunkExportMeta 混合场景（H2 代拍 Q）：expandedCount>0 加「（已展开 K）」括注；=0 逐字节兼容', () => {
    const s = buildTrunkScene(graphFixture())!; // 2 簇 1 hub
    assert.equal(trunkExportMeta(s, '主题', '枢纽', 2), '主题 2（已展开 2） · 枢纽 1');
    assert.equal(trunkExportMeta(s, '主题', '枢纽', 0), '主题 2 · 枢纽 1');
    assert.equal(trunkExportMeta(s, '主题', '枢纽'), '主题 2 · 枢纽 1');
    assert.equal(trunkExportMeta(s, '主题', '枢纽', 1, '展開中'), '主题 2（展開中 1） · 枢纽 1');
    assert.equal(trunkExportMeta({ ...s, clusters: [] }, '主题', '枢纽', 1), '枢纽 1'); // 无簇段无括注
  });
});

// ─── 嵌套子域（换核设计 §五：形态 A）───
describe('嵌套子域（layoutChildClusters / budgetChildLabels / children 透传）', () => {
  const mkChildren = (sizes: number[]): TrunkCluster[] =>
    sizes.map((s, i) => ({ id: `c1.${i + 1}`, label: `子域${i + 1}`, size: s, memberIds: [] }));

  it('⑧ 子域排布：确定性、两两不重叠、包络在父团内（构造性保证）', () => {
    const children = mkChildren([50, 40, 30, 20, 10, 5, 3]);
    const parentR = trunkBlobRadius(158);
    const p1 = layoutChildClusters(children, parentR);
    const p2 = layoutChildClusters(children, parentR);
    assert.deepEqual([...p1.entries()], [...p2.entries()], '同输入两次逐字段相等');

    const list = children.map((c) => ({ id: c.id, ...p1.get(c.id)! }));
    for (const a of list) {
      assert.ok(Math.hypot(a.x, a.y) + a.r <= parentR + 1e-9, `${a.id} 包络在父团内`);
      for (const b of list) {
        if (a.id >= b.id) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= a.r + b.r - 1e-9, `${a.id}/${b.id} 不重叠（dist=${dist.toFixed(2)}, r+r=${(a.r + b.r).toFixed(2)}）`);
      }
    }
  });

  it('⑨ 环缝重叠反例（终审 Important #4）：等大子域填满环时首尾不得重叠', () => {
    // 「一大 + 一串等大」恰好填满一环 → 最后一个与环上第一个之间的闭合缝
    // 必须校验（终审数值反例：s0/s6 重叠 3.58 单位）
    const children = mkChildren([5, 4, 4, 4, 4, 4, 4, 4]);
    const parentR = trunkBlobRadius(33);
    const p = layoutChildClusters(children, parentR);
    const list = children.map((c) => ({ id: c.id, ...p.get(c.id)! }));
    for (const a of list) {
      assert.ok(Math.hypot(a.x, a.y) + a.r <= parentR + 1e-9, `${a.id} 包络内`);
      for (const b of list) {
        if (a.id >= b.id) continue;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        assert.ok(dist >= a.r + b.r - 1e-9, `${a.id}/${b.id} 不重叠（dist=${dist.toFixed(2)}, r+r=${(a.r + b.r).toFixed(2)}）`);
      }
    }
  });

  it('⑨b 单子域居中；空 children 返回空 Map', () => {
    const one = layoutChildClusters(mkChildren([100]), 20);
    assert.deepEqual(one.get('c1.1'), { x: 0, y: 0, r: 2 + Math.sqrt(100) });
    assert.equal(layoutChildClusters([], 20).size, 0);
  });

  it('⑩ 标签预算：size 降序前 5 常显，其余 +K；同 size 按 id 稳定', () => {
    const children = mkChildren([50, 40, 30, 20, 10, 5, 3, 2]);
    const b = budgetChildLabels(children);
    assert.deepEqual(b.visible, ['c1.1', 'c1.2', 'c1.3', 'c1.4', 'c1.5']);
    assert.equal(b.overflow, 3);
    // 同 size 平票按 id 字典序
    const tie = budgetChildLabels(mkChildren([9, 9, 9, 9, 9, 9, 9]), 5);
    assert.deepEqual(tie.visible, ['c1.1', 'c1.2', 'c1.3', 'c1.4', 'c1.5']);
    assert.equal(tie.overflow, 2);
    // ≤5 全显不溢出
    assert.deepEqual(budgetChildLabels(mkChildren([5, 4, 3])), { visible: ['c1.1', 'c1.2', 'c1.3'], overflow: 0 });
  });

  it('⑪ children 透传：payload 带 children 进 scene（递归）；无 children 平面（fail-open）', () => {
    const base = communitiesFixture();
    const nested: GraphCommunities = {
      ...base,
      clusters: [
        {
          ...base.clusters[0]!,
          children: [
            { id: 'c1.1', label: 'fa/a·5', memberIds: ['topic-a/a1.md'], size: 1, children: [{ id: 'c1.1.1', label: 'x·1', memberIds: ['topic-a/a1.md'], size: 1 }] },
            { id: 'c1.2', label: 'fb/b·1', memberIds: ['topic-a/a2.md'], size: 1 },
          ],
        },
        base.clusters[1]!,
      ],
    };
    const g = { ...graphFixture(), communities: nested };
    const scene = buildTrunkScene(g)!;
    assert.equal(scene.clusters[0]!.children?.length, 2);
    assert.equal(scene.clusters[0]!.children![0]!.children![0]!.id, 'c1.1.1');
    // 旧 payload（无 children）→ 全部平面
    const flat = buildTrunkScene(graphFixture())!;
    for (const c of flat.clusters) assert.equal(c.children, undefined);
  });

  it('⑫ findClusterDeep：嵌套 id 深解析（含孙代）；不存在 → null', () => {
    const base = communitiesFixture();
    const nested: GraphCommunities = {
      ...base,
      clusters: [
        {
          ...base.clusters[0]!,
          children: [
            { id: 'c1.1', label: 'a', memberIds: ['topic-a/a1.md'], size: 1, children: [{ id: 'c1.1.1', label: 'x', memberIds: ['topic-a/a1.md'], size: 1 }] },
            { id: 'c1.2', label: 'b', memberIds: ['topic-a/a2.md'], size: 1 },
          ],
        },
        base.clusters[1]!,
      ],
    };
    const scene = buildTrunkScene({ ...graphFixture(), communities: nested })!;
    assert.equal(findClusterDeep(scene.clusters, 'c1')!.label, '主题甲');
    assert.equal(findClusterDeep(scene.clusters, 'c1.2')!.label, 'b');
    assert.equal(findClusterDeep(scene.clusters, 'c1.1.1')!.label, 'x');
    assert.equal(findClusterDeep(scene.clusters, 'c9'), null);
  });

  it('⑬ 质心校正：向质心混合后仍不重叠、包络内、确定性；空质心=保持基础排布', () => {
    const children = mkChildren([50, 40, 30, 20, 10, 5, 3]);
    const parentR = trunkBlobRadius(158);
    // 质心故意挤在同一象限（校正最坏情形）
    const centroids = new Map(children.map((c, i) => [c.id, { x: (i % 3) * 4 - 4, y: Math.floor(i / 3) * 4 - 4 }] as const));
    const p1 = blendChildPlacements(children, parentR, centroids);
    const p2 = blendChildPlacements(children, parentR, centroids);
    assert.deepEqual([...p1.entries()], [...p2.entries()], '确定性');
    const list = children.map((c) => ({ id: c.id, ...p1.get(c.id)! }));
    for (const a of list) {
      assert.ok(Math.hypot(a.x, a.y) + a.r <= parentR + 1e-9, `${a.id} 包络内`);
      for (const b of list) {
        if (a.id >= b.id) continue;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.r + b.r - 1e-6, `${a.id}/${b.id} 不重叠`);
      }
    }
    // 空质心 → 与基础排布一致
    const empty = blendChildPlacements(children, parentR, new Map());
    assert.deepEqual([...empty.entries()], [...layoutChildClusters(children, parentR).entries()]);
  });

  it('⑭ 搜索拍平：子域以「父·子」标签进候选；无子域=仅顶层', () => {
    const clusters: TrunkCluster[] = [
      { id: 'c1', label: '工厂', size: 100, memberIds: [], children: [
        { id: 'c1.1', label: 'V1.6', size: 60, memberIds: [] },
        { id: 'c1.2', label: 'V1.5', size: 40, memberIds: [] },
      ] },
      { id: 'c2', label: '培训', size: 30, memberIds: [] },
    ];
    const flat = flattenSearchableClusters(clusters);
    assert.deepEqual(
      flat.map((x) => [x.id, x.label, x.size]),
      [
        ['c1', '工厂', 100],
        ['c1.1', '工厂·V1.6', 60],
        ['c1.2', '工厂·V1.5', 40],
        ['c2', '培训', 30],
      ],
    );
  });

  it('⑮ topIdOf 归一 + 校正决策：展开在场 → null（不得撕扯展开动画，终审 #6）', () => {
    assert.equal(topIdOf('c1'), 'c1');
    assert.equal(topIdOf('c1.2'), 'c1');
    assert.equal(topIdOf('c1.2.3'), 'c1');

    const clusters: TrunkCluster[] = [
      { id: 'c1', label: 'a', size: 2, memberIds: ['a.md', 'b.md'], children: [
        { id: 'c1.1', label: 'x', size: 1, memberIds: ['a.md'] },
        { id: 'c1.2', label: 'y', size: 1, memberIds: ['b.md'] },
      ] },
    ];
    const positions = new Map([
      ['a.md', { x: 10, y: 0 }],
      ['b.md', { x: 0, y: 10 }],
    ]);
    // 展开在场 → null（Review Focus #3）；布局未就绪 → null
    assert.equal(planChildCorrections(clusters, positions, 1), null);
    assert.equal(planChildCorrections(clusters, null, 0), null);
    // 正常路径：质心相对系（父心 (5,5) → 子域质心 (5,-5)/(-5,5)）
    const plans = planChildCorrections(clusters, positions, 0)!;
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0]!.centroids.get('c1.1'), { x: 5, y: -5 });
    assert.deepEqual(plans[0]!.centroids.get('c1.2'), { x: -5, y: 5 });
    // 无子域 → null
    assert.equal(planChildCorrections([{ id: 'c9', label: 'z', size: 1, memberIds: ['q.md'] }], positions, 0), null);
  });
});
