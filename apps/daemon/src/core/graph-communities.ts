/**
 * 知识图谱社区发现（trunk 视图 T1）——确定性 Louvain + hub 保留 + trunk 聚合边。
 *
 * 纯函数：吃 buildGraph 的产物（GraphData），吐 contracts 的 GraphCommunities。
 * 在图 worker 内随 buildGraph 一起跑（Louvain O(E)·轮数，40k 边毫秒级——spike
 * 实测 20ms/6981 节点），随图一起进 VaultCache——communities 是派生数据，随图
 * 同生命周期（设计 docs/2026-11-15-graph-trunk-view-design.md §4.1；换核设计
 * docs/2026-11-27-graph-community-hierarchy-design.md）。
 *
 * **确定性是硬要求**（同图两次计算逐字段相等）：一切迭代都走排序后的数组；
 * Louvain 内核平票取社区最小原始 key（graph-louvain.ts）；簇按成员最小 key
 * 排序编号 c1..cn；聚合边端点按字典序规范化后排序；内核不使用随机。
 *
 * hub 口径（2026-11-18 校准修订，换核后保持）：hub 边不进社区发现——hub 是
 * 跨社区的桥而非社区成员，计入模块度会把全部社区冲成一个大簇；纯 hub 卫星
 * （只连 hub 的节点）因此无社区结构，计入碎屑。hub 本身照旧不进任何
 * memberIds（§4.1 评审 #7）。
 *
 * trunk 渲染预算：簇数 ≤ TRUNK_MAX_CLUSTERS，超出按尺寸保留前 N、其余整簇
 * 折入碎屑；cap 折叠占比过大时 quality=degenerate 如实告知。
 *
 * 数据口径（§4.1 评审 #7）：死链幻影（deadLink）与孤立节点不进社区发现输入、
 * 不计入聚合边，只计入 crumbCount；簇 size/命名统计只数 memberIds。
 */

import type {
  GraphCluster,
  GraphCommunities,
  GraphCommunityLink,
  GraphData,
  GraphNode,
} from '@molio/contracts';
import { louvainCommunities, type LouvainEdge } from './graph-louvain.js';

/** 小库不启用 trunk 的默认节点数门（MOLIO_GRAPH_TRUNK_MIN_NODES 可覆盖，≤0 = 强制启用） */
export const DEFAULT_TRUNK_MIN_NODES = 500;

/** hub 判定下限：度数 ≥ max(50, 5×P90(连通真实节点度数)) */
const HUB_MIN_DEGREE = 50;
const HUB_P90_MULT = 5;

export interface DetectCommunitiesOptions {
  /** 小库门，默认 DEFAULT_TRUNK_MIN_NODES */
  minNodes?: number;
  /** 默认 max(HUB_MIN_DEGREE, HUB_P90_MULT×P90(输入节点度数))；测试注入小值 */
  hubThreshold?: number;
  /** 默认 5；低于则整簇计入 crumbCount */
  clusterMinSize?: number;
}

/** trunk 簇数量上限：渲染对象 = 簇 + hub，可读预算「几十」（设计 §4.2） */
export const TRUNK_MAX_CLUSTERS = 40;
/** 尘埃合并门：size < 此值的社区若与其他社区有边 → 并入边数最多的邻接社区（换核设计 §四） */
export const DUST_MERGE_MIN = 5;
/** cap 折叠成员占非 hub 输入的比例超过此值 → quality degenerate（碎片化信号） */
const CAP_FOLD_DEGENERATE_SHARE = 0.2;

export function detectCommunities(graph: GraphData, opts: DetectCommunitiesOptions = {}): GraphCommunities {
  const minNodes = opts.minNodes ?? DEFAULT_TRUNK_MIN_NODES;
  const clusterMinSize = opts.clusterMinSize ?? 5;

  const nodeByKey = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeByKey.set(n.key, n);

  // 度数只统计两端都真实存在且都不是死链幻影的边（防御：边引用不存在的 key 时跳过）。
  // 幻影边若计入度数，断链堆积的废页会被推成 trunk hub（且其聚合边为空——屏上一个大点
  // 孤悬），幻影密集的库还会整体抬高 P90 阈值漏判真 hub——口径：幻影只进 crumbCount。
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    const s = nodeByKey.get(e.source);
    const t = nodeByKey.get(e.target);
    if (!s || !t || s.deadLink || t.deadLink) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // crumbCount 基数：死链幻影 + 孤立真实节点（两者永不进簇/聚合边）
  let crumbCount = 0;
  for (const n of graph.nodes) {
    if (n.deadLink || (degree.get(n.key) ?? 0) === 0) crumbCount++;
  }

  if (graph.nodes.length < minNodes) {
    return { clusters: [], hubIds: [], links: [], crumbCount, quality: 'ok' };
  }

  // 连通真实节点（hub 判定的取值域），按 key 升序（确定性的第一来源）
  const connected = graph.nodes
    .filter((n) => !n.deadLink && (degree.get(n.key) ?? 0) >= 1)
    .map((n) => n.key)
    .sort();

  // hub 判定（在 LPA 之前定身份）
  const hubThreshold =
    opts.hubThreshold ?? defaultHubThreshold(connected.map((k) => degree.get(k) ?? 0));
  const hubSet = new Set<string>();
  for (const k of connected) {
    if ((degree.get(k) ?? 0) >= hubThreshold) hubSet.add(k);
  }

  // 社区发现输入：真实、有边、非 hub 的节点。hub 边不进社区发现——hub 是跨社区
  // 的桥，计入模块度会把全部社区冲成一个大簇（校准实测：20 目录 → 1 团）；
  // 纯 hub 卫星因此在输入里零邻居 → 各自成组 → 走小簇碎屑路径。
  const input = connected.filter((k) => !hubSet.has(k));
  const indexOf = new Map<string, number>(input.map((k, i) => [k, i]));

  // 加权边（平行边累计权重——wikilink 重复引用天然加权，Louvain 模块度感知）
  const louvainEdges: LouvainEdge[] = [];
  for (const e of graph.edges) {
    const si = indexOf.get(e.source);
    const ti = indexOf.get(e.target);
    if (si === undefined || ti === undefined || si === ti) continue;
    louvainEdges.push({ source: e.source, target: e.target, weight: 1 });
  }

  // Louvain 划分（组内 key 升序、组间按最小 key 排序 → c1..cn 的编号基础）
  const groups = mergeDust(louvainCommunities(input, louvainEdges), louvainEdges);

  // 小簇整簇计碎屑（hub 已不在输入里，无需再剔除）
  const candidates: string[][] = [];
  for (const members of groups) {
    if (members.length < clusterMinSize) crumbCount += members.length;
    else candidates.push(members);
  }

  // 簇数量上限：按尺寸降序（Array.prototype.sort 稳定 → 同尺寸保持 min-key 序）
  // 保留前 TRUNK_MAX_CLUSTERS，其余整簇折入碎屑；trunk 渲染对象（簇+hub）
  // 必须停留在「几十」预算内（弱内聚库会碎片化出上百小簇，bench 实测 183）。
  candidates.sort((a, b) => b.length - a.length);
  const capped = candidates.slice(0, TRUNK_MAX_CLUSTERS);
  for (const members of candidates.slice(TRUNK_MAX_CLUSTERS)) crumbCount += members.length;
  capped.sort((a, b) => (a[0]! < b[0]! ? -1 : 1)); // 簇 id 恢复「按成员最小 key 编号」

  const idOf = new Map<string, string>();
  const clusters: GraphCluster[] = capped.map((members, i) => {
    const id = `c${i + 1}`;
    for (const k of members) idOf.set(k, id);
    return { id, label: '', memberIds: members, size: members.length };
  });

  // 聚合边：两端都属 trunk 对象（簇或 hub）且异对象；端点字典序规范化后聚合
  const resolveTrunk = (key: string): string | null => {
    if (hubSet.has(key)) return key;
    return idOf.get(key) ?? null;
  };
  const linkTally = new Map<string, number>();
  for (const e of graph.edges) {
    const s = resolveTrunk(e.source);
    const t = resolveTrunk(e.target);
    if (!s || !t || s === t) continue;
    // 分隔符用 NUL：trunk 端点（hub=库内相对路径）可含任意文件名字符（含 →），
    // '→' 做分隔符会把含该字符的端点切碎（T2 修，test 12）
    const SEP = '\u0000';
    const pairKey = s < t ? `${s}${SEP}${t}` : `${t}${SEP}${s}`;
    linkTally.set(pairKey, (linkTally.get(pairKey) ?? 0) + 1);
  }
  const links: GraphCommunityLink[] = [...linkTally.entries()]
    .map(([pair, weight]) => {
      const [source, target] = pair.split('\u0000');
      return { source: source!, target: target!, weight };
    })
    .sort((a, b) => (a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1));

  // 簇命名：顶层文件夹众数 → nodeType 众数 → 「簇 #n」；重名簇全部追加 ·size
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]!;
    const name = clusterName(c.memberIds, nodeByKey) ?? `簇 #${i + 1}`;
    c.label = name;
  }
  const nameCounts = new Map<string, number>();
  for (const c of clusters) nameCounts.set(c.label, (nameCounts.get(c.label) ?? 0) + 1);
  for (const c of clusters) {
    if ((nameCounts.get(c.label) ?? 0) > 1) c.label = `${c.label}·${c.size}`;
  }

  // 退化：①最大簇吞掉 >50% 非 hub 输入节点（巨团）；②cap 折叠成员占比 >
  // CAP_FOLD_DEGENERATE_SHARE（碎片化——社区信号稀薄，trunk 只能呈现冰山一角）
  const nonHubTotal = input.length; // hub 已不在 LPA 输入里
  const maxClusterSize = clusters.reduce((m, c) => Math.max(m, c.size), 0);
  const capFoldedMembers = candidates.slice(TRUNK_MAX_CLUSTERS).reduce((s, m) => s + m.length, 0);
  const degenerate =
    (nonHubTotal > 0 && maxClusterSize / nonHubTotal > 0.5) ||
    (nonHubTotal > 0 && capFoldedMembers / nonHubTotal > CAP_FOLD_DEGENERATE_SHARE);
  const quality: GraphCommunities['quality'] = degenerate ? 'degenerate' : 'ok';

  return { clusters, hubIds: [...hubSet].sort(), links, crumbCount, quality };
}

/**
 * 尘埃合并（换核设计 §四）：size < DUST_MERGE_MIN 的社区若与其他社区有边 →
 * 并入累计边权最大的邻接社区，平票取「最小成员 key」小的目标；**迭代到不动点**
 * （dust→dust→大簇的链尾巴不漏）。无边尘埃原样返回（交由下游碎屑路径）。
 * 语义对齐 LPA 时代的级联吸收——防 Louvain 长尾把 crumbCount 从「孤立点」
 * 膨胀成「社区残骸」（spike 实测全图 ~1300 个 ≤2 组）。
 *
 * 确定性：每轮按组最小 key 排序后扫描、每轮只做一次合并后整轮重启；平票取
 * 首个最大值（= 最小 key 组）。
 */
function mergeDust(groups: string[][], edges: ReadonlyArray<LouvainEdge>): string[][] {
  // key → (邻接 key → 累计权重)
  const neighborWeights = new Map<string, Map<string, number>>();
  const bump = (a: string, b: string, w: number) => {
    let m = neighborWeights.get(a);
    if (!m) {
      m = new Map<string, number>();
      neighborWeights.set(a, m);
    }
    m.set(b, (m.get(b) ?? 0) + w);
  };
  for (const e of edges) {
    bump(e.source, e.target, e.weight);
    bump(e.target, e.source, e.weight);
  }

  let partitions = groups.map((g) => [...g]);
  for (;;) {
    partitions = partitions.filter((g) => g.length > 0).sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    const groupOf = new Map<string, number>();
    partitions.forEach((g, gi) => g.forEach((k) => groupOf.set(k, gi)));

    let merged = false;
    for (let gi = 0; gi < partitions.length && !merged; gi++) {
      const g = partitions[gi]!;
      if (g.length >= DUST_MERGE_MIN) continue;
      const tally = new Map<number, number>();
      for (const k of g) {
        for (const [nb, w] of neighborWeights.get(k) ?? []) {
          const tgi = groupOf.get(nb);
          if (tgi === undefined || tgi === gi) continue;
          tally.set(tgi, (tally.get(tgi) ?? 0) + w);
        }
      }
      // 最大累计权重；平票显式取「目标组最小成员 key」小者（Map 插入序不可依赖）
      let best = -1;
      let bestW = 0;
      let bestKey = '';
      for (const [tgi, w] of tally) {
        const tKey = partitions[tgi]![0]!;
        if (w > bestW || (w === bestW && best >= 0 && tKey < bestKey)) {
          bestW = w;
          best = tgi;
          bestKey = tKey;
        }
      }
      if (best >= 0) {
        partitions[best]!.push(...g);
        partitions[best]!.sort();
        partitions[gi] = [];
        merged = true; // 整轮重启：下一轮以最新分组重算（不动点）
      }
    }
    if (!merged) return partitions.filter((g) => g.length > 0);
  }
}

/** 默认 hub 阈值：max(50, 5×P90(度数))；P90 线性插值。空输入 → 阈值 50。 */
function defaultHubThreshold(degrees: number[]): number {
  if (degrees.length === 0) return HUB_MIN_DEGREE;
  const sorted = [...degrees].sort((a, b) => a - b);
  const pos = 0.9 * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const p90 = lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  return Math.max(HUB_MIN_DEGREE, HUB_P90_MULT * p90);
}

/**
 * 唯一命名则返回，否则 null（调用方退化到下一档）：
 * 顶层文件夹众数（path 首段，无 `/` 记 '' 桶；'' 赢=无文件夹结构 → null）
 * → nodeType 众数（并列/全无 → null）。
 */
function clusterName(memberIds: string[], nodeByKey: Map<string, GraphNode>): string | null {
  const folder = uniqueMajority(memberIds.map((k) => topFolder(nodeByKey.get(k)?.path ?? k)), '');
  if (folder !== null) return folder;
  const nodeTypes = memberIds
    .map((k) => nodeByKey.get(k)?.nodeType)
    .filter((t): t is string => !!t);
  return uniqueMajority(nodeTypes, null);
}

function topFolder(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** 众数唯一且不等于排除值 → 该值；并列/空/命中排除值 → null */
function uniqueMajority(values: string[], excluded: string | null): string | null {
  if (values.length === 0) return null;
  const tally = new Map<string, number>();
  for (const v of values) tally.set(v, (tally.get(v) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  let ties = 0;
  for (const [v, c] of tally) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
      ties = 1;
    } else if (c === bestCount) {
      ties++;
    }
  }
  if (ties !== 1 || best === null || best === excluded) return null;
  return best;
}
