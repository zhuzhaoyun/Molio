/**
 * 图谱数据层纯函数：归一化 / ego BFS 切片 / bloom 合并与代际 LRU 驱逐 /
 * frontier 计算 / overview top-N 截断。
 *
 * 设计参照 Tencent WeKnora（MIT License）wiki 图谱的数据层
 * （frontend/src/views/knowledge/wiki/WikiBrowser.vue L3148-3512 的
 * loadEgoGraph / mergeGraphData / evictBloomOverflow / growFrontier），
 * 差异：WeKnora 的切片发生在 Go 后端（4 万页规模），Molio 是个人知识库，
 * daemon 一次下发全图，这些切片全部在浏览器本地完成。
 */

import type { GraphData, GraphNode, GraphEdge } from '@molio/contracts';

/** 合成死链节点的 key 前缀（沿用旧 GraphPage 约定） */
export const DEAD_PREFIX = '__dead__';

/** 画布节点硬上限：超限按最老 bloom 代际驱逐（同 WeKnora BLOOM_MAX_NODES） */
export const BLOOM_MAX_NODES = 1500;

/** overview 软上限：全图超限时按 linkCount 取 top-N（同 WeKnora top-500 思路，阈值放宽） */
export const OVERVIEW_CAP = 800;

/** ego BFS 默认深度（同 WeKnora GRAPH_EGO_DEFAULT_DEPTH） */
export const EGO_DEFAULT_DEPTH = 1;

/** ego BFS 深度上限（防呆） */
export const EGO_MAX_DEPTH = 2;

/** 画布数据 —— 引擎渲染的直接输入（未归一化为引擎形态前的 GraphData 子集） */
export interface CanvasData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** 全图归一化结果：真实节点 + 合成死链节点 + 邻接表 */
export interface NormalizedGraph {
  /** key → 节点（含 `__dead__<name>` 合成节点） */
  nodeMap: Map<string, GraphNode>;
  /** 全部边（含指向死链节点的合成边），无向去重 */
  edges: GraphEdge[];
  /** 无向邻接表（含死链节点） */
  adjacency: Map<string, Set<string>>;
}

/** 无向边去重 key：两端排序后拼接（A-B 与 B-A 视为同一条） */
export function undirectedEdgeKey(source: string, target: string): string {
  return source < target ? `${source}↔${target}` : `${target}↔${source}`;
}

/**
 * 归一化 daemon 全图：
 * - 真实节点入 map；
 * - deadLinks 按 targetName 去重合成 `__dead__<name>` 节点
 *   （linkCount = 引用它的死链条目数，label 加 "(?)" 后缀，同旧版约定）；
 * - 为每条死链合成 sourceFile → 死链节点 的边（旧版死链是孤立散点，
 *   新版连上引用来源，一眼能看出死链属于哪个文件）；
 * - 构建无向邻接表。
 */
export function normalizeGraphData(data: GraphData): NormalizedGraph {
  const nodeMap = new Map<string, GraphNode>();
  for (const n of data.nodes) {
    nodeMap.set(n.key, { ...n });
  }

  // 死链按 targetName 聚合计数
  const deadCounts = new Map<string, number>();
  for (const dl of data.deadLinks) {
    deadCounts.set(dl.targetName, (deadCounts.get(dl.targetName) ?? 0) + 1);
  }
  for (const [name, count] of deadCounts) {
    nodeMap.set(DEAD_PREFIX + name, {
      key: DEAD_PREFIX + name,
      label: name + ' (?)',
      path: '',
      linkCount: count,
      deadLink: true,
    });
  }

  // 边：真实边（两端须存在）+ 死链合成边，无向去重、跳过自环
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  const pushEdge = (source: string, target: string) => {
    if (source === target) return;
    if (!nodeMap.has(source) || !nodeMap.has(target)) return;
    const k = undirectedEdgeKey(source, target);
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ source, target });
  };
  for (const e of data.edges) pushEdge(e.source, e.target);
  for (const dl of data.deadLinks) pushEdge(dl.sourceFile, DEAD_PREFIX + dl.targetName);

  // 邻接表
  const adjacency = new Map<string, Set<string>>();
  for (const key of nodeMap.keys()) adjacency.set(key, new Set());
  for (const e of edges) {
    adjacency.get(e.source)!.add(e.target);
    adjacency.get(e.target)!.add(e.source);
  }

  return { nodeMap, edges, adjacency };
}

/**
 * 以 center 为圆心的 BFS 邻域切片（本地版 WeKnora ego 模式）。
 * 边只保留两端都在切片内的；center 不存在时返回空画布。
 */
export function egoSlice(
  full: NormalizedGraph,
  center: string,
  depth: number = EGO_DEFAULT_DEPTH,
): CanvasData {
  const maxDepth = Math.max(1, Math.min(EGO_MAX_DEPTH, Math.floor(depth)));
  if (!full.nodeMap.has(center)) return { nodes: [], edges: [] };

  const visited = new Set<string>([center]);
  let frontier = [center];
  for (let d = 0; d < maxDepth; d++) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const neighbor of full.adjacency.get(key) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const nodes: GraphNode[] = [];
  for (const key of visited) {
    const n = full.nodeMap.get(key);
    if (n) nodes.push(n);
  }
  const edges = full.edges.filter((e) => visited.has(e.source) && visited.has(e.target));
  return { nodes, edges };
}

/**
 * bloom 合并：把 incoming 折入 base，节点按 key 去重、边按无向 key 去重；
 * 新到达的节点打上代际 gen（LRU 驱逐按代际从老到新）。
 * 返回新对象，不改动入参。
 */
export function mergeGraphData(
  base: CanvasData,
  incoming: CanvasData,
  gen: number,
  generations: Map<string, number>,
): CanvasData {
  const nodeByKey = new Map<string, GraphNode>();
  for (const n of base.nodes) nodeByKey.set(n.key, n);
  for (const n of incoming.nodes) {
    if (!nodeByKey.has(n.key)) {
      nodeByKey.set(n.key, n);
      generations.set(n.key, gen);
    }
  }

  const edgeSeen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of [...base.edges, ...incoming.edges]) {
    const k = undirectedEdgeKey(e.source, e.target);
    if (!edgeSeen.has(k)) {
      edgeSeen.add(k);
      edges.push(e);
    }
  }

  return { nodes: Array.from(nodeByKey.values()), edges };
}

/**
 * 代际 LRU 驱逐：节点数超过 maxNodes 时，从最老的 bloom 代际开始移除
 * （连同关联边），直到不超限。豁免：gen-0（初始视图）、protect 集合
 * （ego 中心 / 最近 bloom 锚点 / 当前选中 —— 用户的心智锚点不能消失）。
 * 返回新对象；未超限时原样返回。
 */
export function evictBloomOverflow(
  data: CanvasData,
  protect: Set<string>,
  generations: Map<string, number>,
  maxNodes: number = BLOOM_MAX_NODES,
): CanvasData {
  if (data.nodes.length <= maxNodes) return data;

  // 按代际分组（仅 gen >= 1 可被驱逐）
  const byGen = new Map<number, string[]>();
  for (const n of data.nodes) {
    const g = generations.get(n.key) ?? 0;
    if (g === 0) continue;
    if (protect.has(n.key)) continue;
    if (!byGen.has(g)) byGen.set(g, []);
    byGen.get(g)!.push(n.key);
  }
  const gens = Array.from(byGen.keys()).sort((a, b) => a - b);

  const toRemove = new Set<string>();
  let remaining = data.nodes.length;
  for (const g of gens) {
    if (remaining <= maxNodes) break;
    for (const key of byGen.get(g)!) {
      if (remaining <= maxNodes) break;
      toRemove.add(key);
      remaining -= 1;
    }
  }
  if (toRemove.size === 0) return data;

  for (const key of toRemove) generations.delete(key);
  return {
    nodes: data.nodes.filter((n) => !toRemove.has(n.key)),
    edges: data.edges.filter((e) => !toRemove.has(e.source) && !toRemove.has(e.target)),
  };
}

/**
 * frontier（前沿节点）：画布内"全图度数 > 画布可见度数"的节点，
 * 即还有隐藏邻居可以展开的节点（扩展环可见的那些）。
 * 排除 ego 中心（它的差额是死链/被过滤项，不可加载）与死链节点。
 * 供后续 growFrontier 批量展开用（v1 不接 UI）。
 */
export function computeFrontier(
  canvas: CanvasData,
  full: NormalizedGraph,
  center: string,
): string[] {
  const visibleDegree = new Map<string, number>();
  for (const e of canvas.edges) {
    visibleDegree.set(e.source, (visibleDegree.get(e.source) ?? 0) + 1);
    visibleDegree.set(e.target, (visibleDegree.get(e.target) ?? 0) + 1);
  }
  const frontier: string[] = [];
  for (const n of canvas.nodes) {
    if (n.key === center) continue;
    if (n.deadLink) continue;
    const fullDegree = full.adjacency.get(n.key)?.size ?? 0;
    if (fullDegree > (visibleDegree.get(n.key) ?? 0)) frontier.push(n.key);
  }
  return frontier;
}

/**
 * overview 画布：按可见性谓词过滤后，若节点数超过 cap，
 * 取 linkCount 降序（key 升序 tie-break，保证确定性输出）的 top-N，
 * 边只保留两端都在 top-N 内的。返回画布与是否发生截断。
 */
export function overviewTopN(
  full: NormalizedGraph,
  visible: (n: GraphNode) => boolean,
  cap: number = OVERVIEW_CAP,
): { data: CanvasData; truncated: boolean } {
  let candidates = Array.from(full.nodeMap.values()).filter(visible);
  const truncated = candidates.length > cap;
  if (truncated) {
    candidates = candidates
      .sort(
        (a, b) =>
          b.linkCount - a.linkCount ||
          // 同度数时真实节点优先于死链节点（死链不该挤掉内容的 top-N 席位）
          Number(a.deadLink ?? false) - Number(b.deadLink ?? false) ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      )
      .slice(0, cap);
  }
  const inSet = new Set(candidates.map((n) => n.key));
  const edges = full.edges.filter((e) => inSet.has(e.source) && inSet.has(e.target));
  return { data: { nodes: candidates, edges }, truncated };
}

/**
 * 计算每个节点的"画布外隐藏邻居数"：全图度数 - 画布可见度数。
 * 驱动引擎的扩展环（虚线）与 ⊕ bloom 按钮。
 * 死链节点恒为 0（无邻接可展开）。
 */
export function computeHiddenNeighbors(
  canvas: CanvasData,
  full: NormalizedGraph,
): Map<string, number> {
  const visibleDegree = new Map<string, number>();
  for (const e of canvas.edges) {
    visibleDegree.set(e.source, (visibleDegree.get(e.source) ?? 0) + 1);
    visibleDegree.set(e.target, (visibleDegree.get(e.target) ?? 0) + 1);
  }
  const result = new Map<string, number>();
  for (const n of canvas.nodes) {
    if (n.deadLink) {
      result.set(n.key, 0);
      continue;
    }
    const fullDegree = full.adjacency.get(n.key)?.size ?? 0;
    result.set(n.key, Math.max(0, fullDegree - (visibleDegree.get(n.key) ?? 0)));
  }
  return result;
}
