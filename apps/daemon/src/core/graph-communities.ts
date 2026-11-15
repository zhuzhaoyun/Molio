/**
 * 知识图谱社区发现（trunk 视图 T1）——确定性 LPA + hub 保留 + trunk 聚合边。
 *
 * 纯函数：吃 buildGraph 的产物（GraphData），吐 contracts 的 GraphCommunities。
 * 在图 worker 内随 buildGraph 一起跑（O(E)/迭代，23k 边毫秒级），随图一起进
 * VaultCache——communities 是派生数据，随图同生命周期（设计
 * docs/2026-11-15-graph-trunk-view-design.md §4.1）。
 *
 * **确定性是硬要求**（同图两次计算逐字段相等）：一切迭代都走排序后的数组；
 * LPA 投票平票取 label id 更小者；簇按成员最小 key 排序编号 c1..cn；
 * 聚合边端点按字典序规范化后排序。不许引入任何随机源。
 *
 * 数据口径（§4.1 评审 #7）：死链幻影（deadLink）与孤立节点不进 LPA 输入、
 * 不计入聚合边，只计入 crumbCount；hub 不进任何 memberIds；簇 size/命名
 * 统计只数 memberIds。
 */

import type {
  GraphCluster,
  GraphCommunities,
  GraphCommunityLink,
  GraphData,
  GraphNode,
} from '@molio/contracts';

/** 小库不启用 trunk 的默认节点数门（MOLIO_GRAPH_TRUNK_MIN_NODES 可覆盖，≤0 = 强制启用） */
export const DEFAULT_TRUNK_MIN_NODES = 500;

/** hub 判定下限：度数 ≥ max(50, 5×P90(输入节点度数)) */
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

/** LPA 最大迭代轮数：23k 边毫秒级/轮，30 轮足够收敛（不收敛也输出当前划分） */
const LPA_MAX_ROUNDS = 30;

export function detectCommunities(graph: GraphData, opts: DetectCommunitiesOptions = {}): GraphCommunities {
  const minNodes = opts.minNodes ?? DEFAULT_TRUNK_MIN_NODES;
  const clusterMinSize = opts.clusterMinSize ?? 5;

  const nodeByKey = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeByKey.set(n.key, n);

  // 度数只统计两端都真实存在的边（防御：边引用不存在的 key 时跳过）
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    if (nodeByKey.has(e.source)) degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    if (nodeByKey.has(e.target)) degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  // crumbCount 基数：死链幻影 + 孤立真实节点（两者永不进簇/聚合边）
  let crumbCount = 0;
  for (const n of graph.nodes) {
    if (n.deadLink || (degree.get(n.key) ?? 0) === 0) crumbCount++;
  }

  if (graph.nodes.length < minNodes) {
    return { clusters: [], hubIds: [], links: [], crumbCount, quality: 'ok' };
  }

  // LPA 输入：真实、有边的节点，按 key 升序（确定性的第一来源）
  const input = graph.nodes
    .filter((n) => !n.deadLink && (degree.get(n.key) ?? 0) >= 1)
    .map((n) => n.key)
    .sort();
  const indexOf = new Map<string, number>(input.map((k, i) => [k, i]));

  // hub 判定（在 LPA 之前定身份，LPA 之后从簇里剔除）
  const hubThreshold =
    opts.hubThreshold ?? defaultHubThreshold(input.map((k) => degree.get(k) ?? 0));
  const hubSet = new Set<string>();
  for (const k of input) {
    if ((degree.get(k) ?? 0) >= hubThreshold) hubSet.add(k);
  }

  // 邻接表（索引域）
  const neighbors: number[][] = input.map(() => []);
  for (const e of graph.edges) {
    const si = indexOf.get(e.source);
    const ti = indexOf.get(e.target);
    if (si === undefined || ti === undefined || si === ti) continue;
    neighbors[si]!.push(ti);
    neighbors[ti]!.push(si);
  }

  // LPA：初始 label = 输入序号；按 key 序（= 索引序）异步更新；平票取更小 label
  const labels = input.map((_, i) => i);
  for (let round = 0; round < LPA_MAX_ROUNDS; round++) {
    let changed = false;
    for (let i = 0; i < labels.length; i++) {
      const tally = new Map<number, number>();
      for (const nb of neighbors[i]!) tally.set(labels[nb]!, (tally.get(labels[nb]!) ?? 0) + 1);
      // label 升序遍历 + 严格更大才替换 → 最高频且平票取更小 label
      let best = labels[i]!;
      let bestCount = 0;
      for (const l of [...tally.keys()].sort((a, b) => a - b)) {
        const c = tally.get(l)!;
        if (c > bestCount) {
          best = l;
          bestCount = c;
        }
      }
      if (bestCount > 0 && best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // label → 成员组（key 升序），组间按最小 key 排序 → c1..cn 的编号基础
  const byLabel = new Map<number, string[]>();
  input.forEach((k, i) => {
    const l = labels[i]!;
    const bucket = byLabel.get(l);
    if (bucket) bucket.push(k);
    else byLabel.set(l, [k]);
  });
  const groups = [...byLabel.values()].map((members) => members.sort());
  groups.sort((a, b) => (a[0]! < b[0]! ? -1 : 1));

  // hub 从簇剔除（剔除后为空的簇丢弃）
  const kept: string[][] = [];
  for (const members of groups) {
    const filtered = members.filter((k) => !hubSet.has(k));
    if (filtered.length > 0) kept.push(filtered);
  }

  // 小簇整簇计碎屑
  const clusterMembers: string[][] = [];
  for (const members of kept) {
    if (members.length < clusterMinSize) crumbCount += members.length;
    else clusterMembers.push(members);
  }

  const idOf = new Map<string, string>();
  const clusters: GraphCluster[] = clusterMembers.map((members, i) => {
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
    const pairKey = s < t ? `${s}→${t}` : `${t}→${s}`;
    linkTally.set(pairKey, (linkTally.get(pairKey) ?? 0) + 1);
  }
  const links: GraphCommunityLink[] = [...linkTally.entries()]
    .map(([pair, weight]) => {
      const [source, target] = pair.split('→');
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

  // 退化：最大簇吞掉 >50% 非 hub 输入节点
  const nonHubTotal = input.length - hubSet.size;
  const maxClusterSize = clusters.reduce((m, c) => Math.max(m, c.size), 0);
  const quality: GraphCommunities['quality'] =
    nonHubTotal > 0 && maxClusterSize / nonHubTotal > 0.5 ? 'degenerate' : 'ok';

  return { clusters, hubIds: [...hubSet].sort(), links, crumbCount, quality };
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
