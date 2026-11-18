/**
 * trunk 展开/收起纯逻辑（H2，设计 docs/2026-11-18-graph-h2-expand-interaction-design.md §4.1 + 代拍 F/L/O）。
 *
 * 引擎（pixiGraphEngine 的 expand/collapse 增量注入）与 GraphPage（展开编排）只消费这里的产物：
 *   - buildExpansion：展开一簇要注入什么——成员节点 + 簇内真实边 + 成员↔hub/已展开簇真实边
 *     + 成员↔收起簇的 **spoke**（按 (成员, 团) 对去重一条，weight=真实边数，宽 ∝ log——代拍 L）；
 *   - splitBatches：巨簇分批口径（首批 300、后续块 500——代拍 F）；
 *   - computeMiniSim：布局 worker 未就绪时的局部力兜底（质心锚 radial 初始化，init 已放置成员钉住）；
 *   - matchExpansionsOnRefresh：后台刷新后按「最小成员 key」重匹配展开态（≥80% 成员重合才保——代拍 O）。
 *
 * 纯逻辑无 Pixi 依赖（node:test 直测，trunkScene.ts 同款纪律）；d3-force 是纯 JS 可进 node。
 */
import type { GraphData } from '@molio/contracts';
import type { TrunkScene } from './trunkScene.ts';
import { DEFAULT_FORCE_PARAMS } from './types.ts';
import { collideRadiusValue } from './engine/graphUtils.ts';
import {
  forceSimulation,
  forceManyBody,
  forceCenter,
  forceLink,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

export interface ExpansionMemberNode {
  key: string;
  label: string;
  path: string;
  linkCount: number;
  nodeType?: string | null;
}

export interface ExpansionEdge {
  source: string;
  target: string;
  /** spoke 专用：成员↔收起团的真实边数（宽度 ∝ log，代拍 L）；真实边恒 undefined */
  weight?: number;
}

export interface ExpansionPayload {
  clusterId: string;
  memberNodes: ExpansionMemberNode[];
  /** 分批顺序：度数（linkCount）降序，同度按 key 字典序——首批即结构骨干 */
  memberOrder: string[];
  edges: ExpansionEdge[];
}

/** spoke pairKey 分隔符（NUL 转义写法，与引擎 TRUNK_PAIR_SEP 同款纪律：别用裸 \x00 字节） */
const SPOKE_SEP = '\u0000';

/**
 * 展开载荷。对端分类（按优先级）：
 *   同簇成员 → 簇内真实边；hub / 已展开簇成员 → 真实边；
 *   收起簇成员 → spoke（按 (成员, 团) 去重，weight=真实边数）；其余（碎屑/孤立）→ 丢弃（trunk 层不可见）。
 * 簇不存在 → null（调用方防御）。
 */
export function buildExpansion(
  scene: TrunkScene,
  graph: GraphData,
  clusterId: string,
  expandedIds: ReadonlySet<string>,
): ExpansionPayload | null {
  const cluster = scene.clusters.find((c) => c.id === clusterId);
  if (!cluster) return null;

  const hubKeys = new Set(scene.hubs.map((h) => h.key));
  const clusterOf = new Map<string, string>();
  for (const c of scene.clusters) {
    for (const m of c.memberIds) clusterOf.set(m, c.id);
  }
  const nodeByKey = new Map(graph.nodes.map((n) => [n.key, n] as const));

  const memberNodes: ExpansionMemberNode[] = [];
  for (const id of cluster.memberIds) {
    const n = nodeByKey.get(id);
    if (!n) continue; // 防御：脏数据（daemon 保证 memberIds 引用存在）
    memberNodes.push({
      key: n.key,
      label: n.label,
      path: n.path,
      linkCount: n.linkCount,
      nodeType: n.nodeType ?? null,
    });
  }
  const memberSet = new Set(memberNodes.map((m) => m.key));

  const internal: ExpansionEdge[] = [];
  const crossReal: ExpansionEdge[] = [];
  const spokeCount = new Map<string, number>();
  for (const e of graph.edges) {
    const sMember = memberSet.has(e.source);
    const tMember = memberSet.has(e.target);
    if (sMember && tMember) {
      internal.push({ source: e.source, target: e.target });
      continue;
    }
    const memberEnd = sMember ? e.source : tMember ? e.target : null;
    if (memberEnd == null) continue; // 两端都不是本簇成员
    const otherEnd = sMember ? e.target : e.source;
    const otherCluster = clusterOf.get(otherEnd);
    if (hubKeys.has(otherEnd) || (otherCluster != null && expandedIds.has(otherCluster))) {
      crossReal.push({ source: e.source, target: e.target }); // 对端是渲染对象（hub/已展开成员）
    } else if (otherCluster != null && otherCluster !== clusterId) {
      const pairKey = `${memberEnd}${SPOKE_SEP}${otherCluster}`; // 对端在收起簇里 → spoke
      spokeCount.set(pairKey, (spokeCount.get(pairKey) ?? 0) + 1);
    }
    // 其余：对端是碎屑/孤立（不在任何簇）→ trunk 层不可见，丢弃
  }

  const spokes: ExpansionEdge[] = Array.from(spokeCount, ([pairKey, weight]) => {
    const sep = pairKey.indexOf(SPOKE_SEP);
    return { source: pairKey.slice(0, sep), target: pairKey.slice(sep + 1), weight };
  });

  const memberOrder = [...memberNodes]
    .sort((a, b) => (a.linkCount !== b.linkCount ? b.linkCount - a.linkCount : a.key < b.key ? -1 : 1))
    .map((m) => m.key);

  return { clusterId, memberNodes, memberOrder, edges: [...internal, ...crossReal, ...spokes] };
}

/** 分批（代拍 F）：首批 first=300（质心锚 radial 即刻可算），后续块 chunk=500 流式补齐。 */
export function splitBatches(order: string[], first = 300, chunk = 500): string[][] {
  if (order.length === 0) return [];
  const batches: string[][] = [];
  let i = 0;
  let cap = first;
  while (i < order.length) {
    const end = Math.min(i + cap, order.length);
    batches.push(order.slice(i, end));
    i = end;
    cap = chunk;
  }
  return batches;
}

// ── mini-sim（布局兜底）──

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** radial 初始化的基础环距：r = RING·√(i+1)，黄金角旋转（向日葵排布，确定性） */
const MINI_SIM_RING = 30;

interface MiniNode extends SimulationNodeDatum {
  id: string;
  radius: number;
}

/**
 * 局部力布局兜底（worker 未就绪 / 刷新补位）：质心锚 radial 初始化 + DEFAULT_FORCE_PARAMS
 * 配方（与全量图同配方——代拍 P）跑 ticks 步。init 里已放置的成员 **钉住**（fx/fy，评审 #3：
 * 已落位不迁移），新成员围绕生长。返回 sim 坐标（调用方负责质心对齐平移）。
 */
export function computeMiniSim(
  members: string[],
  edges: ExpansionEdge[],
  centroid: { x: number; y: number },
  init?: ReadonlyMap<string, { x: number; y: number }>,
  ticks = 300,
): Map<string, { x: number; y: number }> {
  const memberSet = new Set(members);
  // 度数 → 绘制半径（引擎 radiusOf 口径 nodeScale=1：(2+√deg)×2），collide 用
  const deg = new Map<string, number>();
  const links: SimulationLinkDatum<MiniNode>[] = [];
  for (const e of edges) {
    if (!memberSet.has(e.source) || !memberSet.has(e.target)) continue;
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    links.push({ source: e.source, target: e.target });
  }

  const nodes: MiniNode[] = members.map((id, i) => {
    const pinned = init?.get(id);
    const ring = MINI_SIM_RING * Math.sqrt(i + 1);
    const angle = GOLDEN_ANGLE * i;
    const x = pinned ? pinned.x : centroid.x + ring * Math.cos(angle);
    const y = pinned ? pinned.y : centroid.y + ring * Math.sin(angle);
    return pinned
      ? { id, x, y, fx: pinned.x, fy: pinned.y, radius: 0 }
      : { id, x, y, radius: 0 };
  });
  for (const n of nodes) n.radius = (2 + Math.sqrt(deg.get(n.id) ?? 0)) * 2;

  const f = DEFAULT_FORCE_PARAMS;
  const sim = forceSimulation<MiniNode>(nodes)
    .force('charge', forceManyBody<MiniNode>().strength(f.repelStrength))
    .force('center', forceCenter<MiniNode>(centroid.x, centroid.y).strength(f.centerStrength))
    .force(
      'link',
      forceLink<MiniNode, SimulationLinkDatum<MiniNode>>(links)
        .id((d) => d.id)
        .distance(f.linkDistance)
        // 0 = d3 默认按度数加权（1/min(deg)）——与引擎 setForces 同语义，别把 0 直接喂给 strength
        .strength(f.linkStrength > 0 ? f.linkStrength : (l) => {
          const s = l.source as MiniNode;
          const t = l.target as MiniNode;
          return 1 / Math.max(Math.min(deg.get(s.id) ?? 1, deg.get(t.id) ?? 1), 1);
        }),
    )
    .force('collide', forceCollide<MiniNode>().radius((d) => collideRadiusValue(d.radius)).iterations(3));

  let remaining = ticks;
  while (sim.alpha() > sim.alphaMin() && remaining-- > 0) sim.tick();
  sim.stop();

  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) out.set(n.id, { x: n.x ?? centroid.x, y: n.y ?? centroid.y });
  return out;
}

/** 位置集合的质心（blob 回位 / worker 布局对齐用）。 */
export function centroidOf(positions: ReadonlyMap<string, { x: number; y: number }>): { x: number; y: number } {
  if (positions.size === 0) return { x: 0, y: 0 };
  let sx = 0;
  let sy = 0;
  for (const p of positions.values()) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / positions.size, y: sy / positions.size };
}

/** 整体平移（评审 #3：worker 位置按「簇质心对齐 blob 屏上位置」平移后落位）。不改源 Map。 */
export function translatePositions(
  positions: ReadonlyMap<string, { x: number; y: number }>,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Map<string, { x: number; y: number }> {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const out = new Map<string, { x: number; y: number }>();
  for (const [key, p] of positions) out.set(key, { x: p.x + dx, y: p.y + dy });
  return out;
}

// ── 刷新重匹配（代拍 O）──

export interface RefreshMatch {
  /** oldId → newId（同身份、成员重合达标） */
  keep: Array<{ oldId: string; newId: string }>;
  drop: string[];
}

/**
 * 后台刷新后的展开态重匹配。簇 id 按最小成员 key 重编号（daemon 口径），内容一变就可能漂移，
 * 故身份 = **最小成员 key**；再要求成员集重合 ≥ threshold（默认 0.8）才保展开——
 * 挂到面目全非的簇上比丢掉展开态更糟。prevExpanded 里不在 prevScene 的 id 直接 drop。
 */
export function matchExpansionsOnRefresh(
  prevScene: TrunkScene,
  newScene: TrunkScene,
  prevExpanded: string[],
  threshold = 0.8,
): RefreshMatch {
  const minKey = (ids: string[]) => ids.reduce((a, b) => (a < b ? a : b));
  const prevById = new Map(prevScene.clusters.map((c) => [c.id, c] as const));
  const newByMinKey = new Map(newScene.clusters.map((c) => [minKey(c.memberIds), c] as const));

  const keep: RefreshMatch['keep'] = [];
  const drop: string[] = [];
  for (const oldId of prevExpanded) {
    const oldC = prevById.get(oldId);
    if (!oldC) {
      drop.push(oldId);
      continue;
    }
    const newC = newByMinKey.get(minKey(oldC.memberIds));
    if (!newC) {
      drop.push(oldId);
      continue;
    }
    const oldSet = new Set(oldC.memberIds);
    let overlap = 0;
    for (const m of newC.memberIds) if (oldSet.has(m)) overlap++;
    if (oldC.memberIds.length > 0 && overlap / oldC.memberIds.length >= threshold) {
      keep.push({ oldId, newId: newC.id });
    } else {
      drop.push(oldId);
    }
  }
  return { keep, drop };
}
