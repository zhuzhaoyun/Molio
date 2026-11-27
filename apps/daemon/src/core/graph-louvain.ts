/**
 * Louvain 社区发现内核（纯算法，零依赖）——设计 docs/2026-11-27-graph-community-hierarchy-design.md §四。
 *
 * 在图 worker 内随 graph-communities.ts 跑：真实库 40k 边毫秒级（spike 实测 20ms/6981 节点），
 * 换掉 LPA 的级联吸收——巨团 degenerate 根治（57% → ~13% 实测背书）。
 *
 * **确定性是硬要求**（同输入两次运行逐字段相等）：节点按 key 排序后进入索引空间，
 * 一切迭代走升序索引（Map 整数键天然升序迭代）；候选社区平票取「社区内最小原始 key」
 * 小者；本内核不引入任何随机（seededRandom 仅为调用方导出的固定种子 LCG，单一实现）。
 *
 * 算法（Blondel et al. 2008 两阶段）：
 * - phase-1 局部移动：节点逐一移入使模块度增益最大的邻接社区（增益≤0 不动）；
 * - phase-2 团聚：社区折叠为超节点、边权合并（簇内边→自环），回到 phase-1；
 * - 两层通常足够（spike 证据），最多 4 层防退化。
 *
 * 权重口径：邻接矩阵存无向边两个方向各一次；自环权重 = 簇内边权 ×2（聚合时两个方向
 * 各累加一次）；deg = 行和（自环全额）；m2 = 全体方向条目之和 = 2×总边权（逐层守恒）。
 */

/** 固定种子 LCG——种子是常量 ⇒ 同图两次计算逐字段相等。从 graph-communities.ts 迁出（单一实现）。 */
export function seededRandom(): () => number {
  let s = 20261118;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 输入边：无向、带权；平行边由邻接结构自动累计。 */
export interface LouvainEdge {
  source: string;
  target: string;
  weight: number;
}

/** 当前层的图：紧凑索引空间。nodeKeys[v] = 超节点 v 代表的最小原始 key（平票裁决用）。 */
interface LayerGraph {
  n: number;
  /** adj[i].get(j) = 权重（含自环，j === i，权重已双倍） */
  adj: Array<Map<number, number>>;
  /** deg[i] = 邻接行和（自环全额） */
  deg: Float64Array;
  /** m2 = 2×总边权（含自环守恒） */
  m2: number;
  nodeKeys: string[];
}

/**
 * Louvain 社区划分。返回成员组：组内按 key 升序、组间按组内最小 key 升序；
 * 每个 key 恰出现一次（含无边节点——各自成组，交由调用方做尘埃合并）。
 */
export function louvainCommunities(nodeKeys: readonly string[], edges: ReadonlyArray<LouvainEdge>): string[][] {
  const keys = [...nodeKeys].sort();
  const indexOf = new Map<string, number>(keys.map((k, i) => [k, i]));

  // 顶层邻接：平行边累计；自环输入（source === target）防御性跳过
  const adj: Array<Map<number, number>> = keys.map(() => new Map<number, number>());
  let m2 = 0;
  for (const e of edges) {
    const i = indexOf.get(e.source);
    const j = indexOf.get(e.target);
    if (i === undefined || j === undefined || i === j) continue;
    adj[i]!.set(j, (adj[i]!.get(j) ?? 0) + e.weight);
    adj[j]!.set(i, (adj[j]!.get(i) ?? 0) + e.weight);
    m2 += 2 * e.weight;
  }

  // 原始节点 → 当前层节点的映射（逐层复合）
  let assign = keys.map((_, i) => i);
  let layer: LayerGraph = { n: keys.length, adj, deg: rowSums(adj), m2, nodeKeys: keys };

  for (let level = 0; level < 4; level++) {
    const comm = localMoving(layer);
    if (new Set(comm).size === layer.n) break; // 本层不可再聚合
    assign = assign.map((node) => comm[node]!);
    layer = buildAggregated(layer, comm);
  }

  const groups = new Map<number, string[]>();
  keys.forEach((k, i) => {
    const c = assign[i]!;
    const g = groups.get(c);
    if (g) g.push(k);
    else groups.set(c, [k]);
  });
  return [...groups.values()].sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
}

/** phase-1：局部移动直到一轮无移动。返回逐节点社区编号（聚合层负责规范化）。 */
function localMoving(layer: LayerGraph): Int32Array {
  const { n, adj, deg, m2, nodeKeys } = layer;
  const comm = new Int32Array(n);
  for (let i = 0; i < n; i++) comm[i] = i;
  if (m2 === 0) return comm; // 无边图：不再移动

  const ctot: number[] = new Array<number>(n); // Σtot[c]：社区 c 的度和（含自环）
  for (let i = 0; i < n; i++) ctot[i] = deg[i]!;
  const members: Array<number[] | undefined> = Array.from({ length: n }, (_, i) => [i]);
  let freeLabel = n; // 孤立成新社区的标签分配器

  // 候选 = 有边的社区（**含原社区余部**——它的真实增益通常为正，漏掉会让节点
  // 「离开-想回」死循环，2026-11-27 实现 RED 期实测）+ 孤立（增益 0）。
  // argmax 增益，平票（1e-12 内）取社区最小原始 key 小者；孤立用自身 key。
  // 保险丝：模块度单调性理论上保证收敛，100 轮上限纯防御。
  let improved = true;
  let passes = 0;
  while (improved && passes++ < 100) {
    improved = false;
    for (let i = 0; i < n; i++) {
      const ci = comm[i]!;
      ctot[ci] = ctot[ci]! - deg[i]!; // 摘出 i

      // 邻接社区累计权重（整数键 Map 升序迭代 ⇒ 确定性）
      const weightsTo = new Map<number, number>();
      for (const [j, w] of adj[i]!) {
        const cj = comm[j]!;
        weightsTo.set(cj, (weightsTo.get(cj) ?? 0) + w);
      }

      let best = -1; // -1 = 孤立自成社区
      let bestGain = 0;
      let bestKey = nodeKeys[i]!;
      for (const [c, w] of weightsTo) {
        const gain = w - (ctot[c]! * deg[i]!) / m2;
        const k = minKeyOf(members[c]!, nodeKeys);
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && k < bestKey)) {
          best = c;
          bestGain = gain;
          bestKey = k;
        }
      }
      if (best === -1) best = freeLabel++; // 全部候选不优于孤立 → 孤立

      if (best !== ci) {
        const old = members[ci]!;
        old.splice(old.indexOf(i), 1);
        if (old.length === 0) members[ci] = undefined;
        if (members[best] === undefined) members[best] = [i];
        else members[best]!.push(i);
        comm[i] = best;
        if (ctot[best] === undefined) ctot[best] = 0;
        improved = true;
      }
      ctot[best] = (ctot[best] ?? 0) + deg[i]!; // 放回（原社区、新社区或孤立）
    }
  }
  return comm;
}

/** 社区成员中最小的原始 key（超节点代表 key 的最小值）。 */
function minKeyOf(members: readonly number[], nodeKeys: readonly string[]): string {
  let best = nodeKeys[members[0]!] ?? '';
  for (const m of members) {
    const k = nodeKeys[m]!;
    if (k < best) best = k;
  }
  return best;
}

function rowSums(adj: Array<Map<number, number>>): Float64Array {
  const deg = new Float64Array(adj.length);
  for (let i = 0; i < adj.length; i++) {
    let d = 0;
    for (const w of adj[i]!.values()) d += w;
    deg[i] = d;
  }
  return deg;
}

/** phase-2：社区折叠为超节点，边权合并（簇内边 → 自环，双倍口径守恒）。 */
function buildAggregated(layer: LayerGraph, comm: Int32Array): LayerGraph {
  const ids = [...new Set(comm)].sort((a, b) => a - b);
  const compact = new Map<number, number>(ids.map((c, i) => [c, i]));
  const n = ids.length;
  const adj: Array<Map<number, number>> = Array.from({ length: n }, () => new Map<number, number>());
  let m2 = 0;
  for (let i = 0; i < layer.n; i++) {
    for (const [j, w] of layer.adj[i]!) {
      const a = compact.get(comm[i]!)!;
      const b = compact.get(comm[j]!)!;
      adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
      m2 += w; // 有向条目全计：无向边两方向 + 自环双倍 → m2 逐层守恒
    }
  }
  const nodeKeys = new Array<string>(n);
  for (let v = 0; v < layer.n; v++) {
    const a = compact.get(comm[v]!)!;
    const k = layer.nodeKeys[v]!;
    if (nodeKeys[a] === undefined || k < nodeKeys[a]!) nodeKeys[a] = k;
  }
  return { n, adj, deg: rowSums(adj), m2, nodeKeys };
}
