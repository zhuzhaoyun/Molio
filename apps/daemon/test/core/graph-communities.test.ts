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

  it('3. hub：度数 ≥ hubThreshold 的节点进 hubIds；hub 边不进 LPA（纯 hub 卫星不成簇、计碎屑）', () => {
    // 星形：hub.md 连 s1..s4。辐条只连 hub——hub 是桥不是社区，hub 边不投票后
    // 辐条无任何社区结构 → 不成簇（hub 口径 2026-11-18 校准修订；簇间聚合边由
    // 「簇⇄hub 有真实成员间连边」的 fixture 验证，见 10）
    const nodes = [md('hub.md'), md('s1.md'), md('s2.md'), md('s3.md'), md('s4.md')];
    const edges = ['s1.md', 's2.md', 's3.md', 's4.md'].map((s) => ({ source: 'hub.md', target: s }));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0, hubThreshold: 3, clusterMinSize: 3 });

    assert.deepEqual(c.hubIds, ['hub.md']);
    assert.deepEqual(c.clusters, [], '纯 hub 卫星不是社区');
    assert.deepEqual(c.links, [], '碎屑端点不产生聚合边');
    assert.equal(c.crumbCount, 4, '4 个卫星计入碎屑');
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

  it('4b. 幻影边不计真实度数：断链废页不得成 hub，也不抬高 P90（评审 Important #1）', () => {
    // 5 团（度 4）+ stub.md 有 10 条断链出边（宽口径度 10 > hubThreshold 5）。
    // 幻影边若计入度数，stub 会进 hubIds——断链堆积的废页变成 trunk 枢纽。
    const keysA = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'];
    const { nodes, edges } = twoCliques('topic-a', keysA, null, []);
    nodes.push(md('stub.md'));
    for (let i = 1; i <= 10; i++) edges.push({ source: 'stub.md', target: `__dead__g${i}.md` });
    nodes.push(...Array.from({ length: 10 }, (_, i) => md(`__dead__g${i + 1}.md`, { dead: true })));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0, hubThreshold: 5 });

    assert.deepEqual(c.hubIds, [], '幻影度数不得把 stub 推成 hub');
    const allMembers = c.clusters.flatMap((x) => x.memberIds);
    assert.ok(!allMembers.includes('stub.md'), 'stub 真实度数 0 = 孤立，不进簇');
    assert.equal(c.clusters.length, 1, '5 团完好');
    // stub（孤立真实）+ 10 幻影 = 11；团成员的度不受幻影边稀释
    assert.equal(c.crumbCount, 11);
    assert.deepEqual(c.links, [], '幻影端点不产生聚合边');
  });

  it('4c. 全幻影/孤立小图走默认 hub 阈值路径不 NaN（评审 Important #2：defaultHubThreshold([]) 曾零覆盖）', () => {
    const nodes = [md('stub.md'), md('__dead__x.md', { dead: true }), md('y.md')];
    const edges = [{ source: 'stub.md', target: '__dead__x.md' }];
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });
    // LPA 输入为空 → defaultHubThreshold([]) 必须返回有限数（曾怕 NaN → 恒 false → 永无 hub）
    assert.deepEqual(c.hubIds, []);
    assert.deepEqual(c.clusters, []);
    assert.equal(c.crumbCount, 3);
    assert.equal(c.quality, 'ok');
  });

  it('4d. 默认 hub 阈值公式钉死：星形 51 点（hub 度 50）→ max(50, 5×P90)=50 恰好入选', () => {
    // P90(非 hub 输入度数 [1×50]) = 1 → 5×1=5 → max(50,5)=50；hub 度 50 ≥ 50 入选——
    // 公式任何一处改坏（NaN / 插值错位 / 下限丢失）都会让 hubIds 空。
    const hub = 'hub.md';
    const spokes = Array.from({ length: 50 }, (_, i) => `s${i + 1}.md`);
    const nodes = [md(hub), ...spokes.map((s) => md(s))];
    const edges = spokes.map((s) => ({ source: hub, target: s }));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.deepEqual(c.hubIds, [hub]);
    assert.deepEqual(c.clusters, [], '辐条只连 hub → 纯卫星，不成簇（口径见 3）');
    assert.equal(c.crumbCount, 50);
    assert.equal(c.quality, 'ok');
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

  it('10. hub 漏斗回归（校准发现）：hub 桥接三个团不得把社区冲成单一巨团', () => {
    // 3 个 8 团 + hub.md 与全部 24 成员连边（hub 度 24 ≥ hubThreshold 20）。
    // hub 边若进 LPA：hub label 最小 + 平票取更小 → 一轮洪水全图塌成 1 簇
    //（#416 校准在 6.5k 合成库实测：20 目录全塌，quality=degenerate）。
    const dirs = ['ta', 'tb', 'tc'];
    const keysByDir = dirs.map((d) => Array.from({ length: 8 }, (_, i) => `${d}${i + 1}.md`));
    const nodes = [md('hub.md'), ...keysByDir.flatMap((ks, di) => ks.map((k) => md(k, { folder: dirs[di]! })))];
    // 边引用带 folder 前缀的完整 key（与节点 key 一致）
    const edges = keysByDir.flatMap((ks, di) => cliqueEdges(ks.map((k) => `${dirs[di]}/${k}`)));
    for (const [di, ks] of keysByDir.entries()) {
      for (const k of ks) edges.push({ source: 'hub.md', target: `${dirs[di]}/${k}` });
    }
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0, hubThreshold: 20 });

    assert.deepEqual(c.hubIds, ['hub.md']);
    assert.equal(c.clusters.length, 3, '三个团各自成簇，hub 边不得串票');
    assert.deepEqual(c.clusters.map((x) => x.size), [8, 8, 8]);
    // 聚合边：每簇 ↔ hub 各 8 条真实成员边；端点字典序规范化（cN < hub.md）
    assert.deepEqual(
      c.links.map((l) => [l.source, l.target, l.weight]),
      [
        ['c1', 'hub.md', 8],
        ['c2', 'hub.md', 8],
        ['c3', 'hub.md', 8],
      ],
    );
    assert.equal(c.quality, 'ok');
  });

  it('12. 聚合边 pairKey 分隔符：hub 文件名含 → 不产生歧义 key（#416 deferred minor，T2 消费方）', () => {
    // hub 文件名带 → 字符；旧分隔符 '→' 下 `${s}→${t}` 再 split('→') 会把含 → 的
    // 端点切碎 → 聚合边进错误桶/解析出错误端点。双团让 hub 度（10）与成员度（5）拉开，
    // 阈值 6 只圈中 hub。
    const hub = 'a→b.md';
    const keysA = ['a1.md', 'a2.md', 'a3.md', 'a4.md', 'a5.md'];
    const keysB = ['b1.md', 'b2.md', 'b3.md', 'b4.md', 'b5.md'];
    const { nodes, edges } = twoCliques('topic-a', keysA, 'topic-b', keysB);
    nodes.push(md(hub));
    const full = (dir: string, ks: string[]) => ks.map((k) => `${dir}/${k}`);
    for (const t of [...full('topic-a', keysA), ...full('topic-b', keysB)]) {
      edges.push({ source: hub, target: t });
    }
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0, hubThreshold: 6 });

    assert.deepEqual(c.hubIds, [hub]);
    assert.equal(c.clusters.length, 2);
    // 两条聚合边：c1/c2 ↔ hub 各 5；source/target 必须还原为完整端点字符串。
    // 端点按字典序规范化：'a→b.md' < 'c1' < 'c2' → hub 在前（test 10 里 hub.md > c1 是反例向）
    assert.deepEqual(
      c.links.map((l) => [l.source, l.target, l.weight]),
      [
        [hub, 'c1', 5],
        [hub, 'c2', 5],
      ],
    );
  });

  it('11. 簇上限：超过 TRUNK_MAX_CLUSTERS 的最小簇并入碎屑，折叠占比 >20% → quality degenerate', () => {
    // 60 个 6 团 = 360 节点（全部 ≥ clusterMinSize，不触发小簇路径）。
    // cap 保留 40 团、折叠 20 团（120 人 = 33% > 20%）→ 碎屑 + 簇结构不明显信号。
    const cliques = Array.from({ length: 60 }, (_, d) =>
      Array.from({ length: 6 }, (_, i) => `d${String(d).padStart(2, '0')}n${i + 1}.md`),
    );
    const nodes = cliques.flatMap((ks, d) => ks.map((k) => md(k, { folder: `dir${String(d).padStart(2, '0')}` })));
    const edges = cliques.flatMap((ks, d) => cliqueEdges(ks.map((k) => `dir${String(d).padStart(2, '0')}/${k}`)));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.equal(c.clusters.length, 40);
    assert.equal(c.crumbCount, 120, '被 cap 折叠的 20 团整团计入碎屑');
    assert.equal(c.quality, 'degenerate', '折叠占比 33% > 20%');
    // 折叠端点不得产生聚合边（本 fixture 无跨团边，links 恒空）
    assert.deepEqual(c.links, []);
  });

  it('13. 换核 RED 钉：链图上 Louvain 切成 2-3 节点小段（LPA 会洪水成两大段）', () => {
    // 链 = 无社区结构的病态形状，是两内核的确定性分歧点（2026-11-27 scratch 实测：
    // LPA 2 簇 [13,7]，Louvain 9 组 2~3 节点）。默认 clusterMinSize=5 下 Louvain 的
    // 小段全部落碎屑 → 0 簇 + 全量碎屑 + degenerate。
    // 【演进预告】Task 3 尘埃合并后，带边小段会并入邻接主簇、本 fixture 期望将
    // 随尘埃合并语义更新——本钉子守的是「内核确实是 Louvain」这一事实。
    const n = 20;
    const nodes = Array.from({ length: n }, (_, i) => md(`n${i + 1}.md`, { folder: 'dir' }));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({
      source: `dir/n${i + 1}.md`,
      target: `dir/n${i + 2}.md`,
    }));
    const c = detectCommunities(graph(nodes, edges), { minNodes: 0 });

    assert.equal(c.clusters.length, 0, 'Louvain 链切分全 <5 → 无簇（LPA 会给出 2 簇）');
    assert.equal(c.crumbCount, 20);
    // 小簇碎屑 ≠ cap 折叠：degenerate 只看 cap 折叠占比，此处 quality 仍 ok
    assert.equal(c.quality, 'ok');
  });
});
