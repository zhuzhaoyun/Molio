/**
 * 知识图谱社区发现（trunk 视图 T1）——确定性 LPA + hub 保留 + trunk 聚合边。
 *
 * 纯函数：吃 buildGraph 的产物（GraphData），吐 contracts 的 GraphCommunities。
 * 在图 worker 内随 buildGraph 一起跑（O(E)/迭代，23k 边毫秒级），随图一起进
 * VaultCache——communities 是派生数据，随图同生命周期（设计
 * docs/2026-11-15-graph-trunk-view-design.md §4.1）。
 *
 * **确定性是硬要求**（同图两次计算逐字段相等）：一切迭代都走排序后的数组；
 * LPA 投票平票用**固定种子随机**挑选（经典 LPA 语义——「取更小 label」会让
 * 全局最小 label 一轮洪水吞掉全部社区结构，2026-11-18 bench 校准发现，
 * 回归钉 test 10）；簇按成员最小 key 排序编号 c1..cn；聚合边端点按字典序
 * 规范化后排序。随机源只有固定种子 LCG ⇒ 确定性不变。
 *
 * hub 口径（2026-11-18 校准修订）：hub 边不进 LPA——hub 是跨社区的桥而非
 * 社区成员，让其投票会把全部社区冲成一个巨团；纯 hub 卫星（只连 hub 的节点）
 * 因此无社区结构，计入碎屑。hub 本身照旧不进任何 memberIds（§4.1 评审 #7）。
 *
 * trunk 渲染预算：簇数 ≤ TRUNK_MAX_CLUSTERS，超出按尺寸保留前 N、其余整簇
 * 折入碎屑；cap 折叠占比过大时 quality=degenerate 如实告知。
 *
 * 数据口径（§4.1 评审 #7）：死链幻影（deadLink）与孤立节点不进 LPA 输入、
 * 不计入聚合边，只计入 crumbCount；簇 size/命名统计只数 memberIds。
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

/** LPA 最大迭代轮数：23k 边毫秒级/轮，30 轮足够收敛（不收敛也输出当前划分） */
const LPA_MAX_ROUNDS = 30;

/** trunk 簇数量上限：渲染对象 = 簇 + hub，可读预算「几十」（设计 §4.2） */
export const TRUNK_MAX_CLUSTERS = 40;
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

  // LPA 输入：真实、有边、非 hub 的节点。hub 边不进 LPA——hub 是跨社区的桥，
  // 让它投票会以「平票洪水」把全部社区冲成一个巨团（校准实测：20 目录 → 1 团）；
  // 纯 hub 卫星因此在邻接表里零邻居 → label 不动 → 单例组 → 走小簇碎屑路径。
  const input = connected.filter((k) => !hubSet.has(k));
  const indexOf = new Map<string, number>(input.map((k, i) => [k, i]));

  // 邻接表（索引域）
  const neighbors: number[][] = input.map(() => []);
  for (const e of graph.edges) {
    const si = indexOf.get(e.source);
    const ti = indexOf.get(e.target);
    if (si === undefined || ti === undefined || si === ti) continue;
    neighbors[si]!.push(ti);
    neighbors[ti]!.push(si);
  }

  // LPA：初始 label = 输入序号；按 key 序（= 索引序）异步更新。
  // 平票在并列最高频 label 里用固定种子随机挑：min 平票会让首轮变成
  // 「全图采纳全局最小 label」的洪水（初始 label 全唯一时每个平票都发生），
  // 本地多数派永远拿不到选票；种子化随机是经典 LPA 语义且确定性不变。
  const labels = input.map((_, i) => i);
  const tieBreak = seededRandom();
  for (let round = 0; round < LPA_MAX_ROUNDS; round++) {
    let changed = false;
    for (let i = 0; i < labels.length; i++) {
      const tally = new Map<number, number>();
      for (const nb of neighbors[i]!) tally.set(labels[nb]!, (tally.get(labels[nb]!) ?? 0) + 1);
      let maxCount = 0;
      for (const c of tally.values()) if (c > maxCount) maxCount = c;
      if (maxCount === 0) continue; // 零邻居（纯 hub 卫星）→ label 不动
      const tops = [...tally.entries()]
        .filter(([, c]) => c === maxCount)
        .map(([l]) => l)
        .sort((a, b) => a - b);
      const best = tops[Math.floor(tieBreak() * tops.length)]!;
      if (best !== labels[i]) {
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

/** 固定种子 LCG——LPA 平票随机挑 label 用。种子是常量 ⇒ 同图两次计算逐字段相等。 */
function seededRandom(): () => number {
  let s = 20261118;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
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
