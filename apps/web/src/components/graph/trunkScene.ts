/**
 * trunk 视图纯逻辑层（T2）——GraphData → TrunkScene 派生、生效条件判定、渲染公式。
 *
 * 设计 docs/2026-11-15-graph-trunk-view-design.md §4.2 + roadmap
 * docs/2026-11-18-graph-experience-roadmap.md H1（代拍决策）。
 * 纯函数无 Pixi 依赖（node:test 直测）；引擎层（pixiGraphEngine trunk 模式）与
 * GraphPage 只消费这里的产物，不重复口径。
 */
import type { GraphData, GraphNode, GraphScope } from '@molio/contracts';
import { NODE_TYPE_COLORS } from './types.ts';

export interface TrunkHub {
  key: string;
  label: string;
  path: string;
  nodeType?: string;
  /** 真实边度数（两端节点存在且非死链幻影——与 daemon graph-communities 同口径） */
  linkCount: number;
}

export interface TrunkCluster {
  id: string;
  label: string;
  size: number;
  memberIds: string[];
}

export interface TrunkLink {
  source: string;
  target: string;
  weight: number;
}

export interface TrunkScene {
  hubs: TrunkHub[];
  clusters: TrunkCluster[];
  links: TrunkLink[];
  crumbCount: number;
  quality: 'ok' | 'degenerate';
}

/** communities 缺失或 clusters 空 → null（fail-open：调用方走全量现状） */
export function buildTrunkScene(graph: GraphData): TrunkScene | null {
  const c = graph.communities;
  if (!c || c.clusters.length === 0) return null;

  const nodeByKey = new Map<string, GraphNode>();
  for (const n of graph.nodes) nodeByKey.set(n.key, n);

  // hub 真实度数：防御口径同 daemon（边端点不存在或任一端死链幻影 → 不计）
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    const s = nodeByKey.get(e.source);
    const t = nodeByKey.get(e.target);
    if (!s || !t || s.deadLink || t.deadLink) continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const hubs: TrunkHub[] = [];
  for (const id of c.hubIds) {
    const n = nodeByKey.get(id);
    if (!n) continue; // 防御：hubId 引用不存在（脏数据）
    hubs.push({
      key: n.key,
      label: n.label,
      path: n.path,
      nodeType: n.nodeType,
      linkCount: degree.get(id) ?? 0,
    });
  }

  return {
    hubs,
    clusters: c.clusters.map((x) => ({ id: x.id, label: x.label, size: x.size, memberIds: x.memberIds })),
    links: c.links.map((l) => ({ source: l.source, target: l.target, weight: l.weight })),
    crumbCount: c.crumbCount,
    quality: c.quality,
  };
}

export type TrunkViewReason = 'ok' | 'off' | 'no-communities' | 'filters' | 'scope';

export interface TrunkViewInput {
  scope: GraphScope | null;
  scene: TrunkScene | null;
  globalView: 'trunk' | 'full';
  showOrphans: boolean;
  showDeadLinks: boolean;
  visibleTypes: string[];
  companion: boolean;
}

/**
 * 生效条件（设计 §4.2 verbatim）：graphScope==null && clusters 非空 && viewMode=trunk
 * && 筛选三开关默认态。reason 驱动 UI：no-communities → 开关不渲染；filters → 置灰
 * + 提示；off → 可用未选。优先级 no-communities > filters > off（用户先看到「为什么不能」）。
 * companion 副视图与局部 scope 永不 trunk（设计：它们本就只渲染邻域）。
 */
export function resolveTrunkView(input: TrunkViewInput): { active: boolean; reason: TrunkViewReason } {
  const filtersDefault =
    input.visibleTypes.length === 0 && input.showOrphans && input.showDeadLinks;
  if (input.scope !== null || input.companion || input.scene === null) {
    return { active: false, reason: 'no-communities' };
  }
  if (!filtersDefault) return { active: false, reason: 'filters' };
  if (input.globalView !== 'trunk') return { active: false, reason: 'off' };
  return { active: true, reason: 'ok' };
}

/** 簇团半径 ∝ √成员数（设计 §4.2）：4 + √size（引擎再乘 nodeScale） */
export function trunkBlobRadius(size: number): number {
  return 4 + Math.sqrt(size);
}

/** 聚合边粗细 ∝ log(簇间边数)：1 + log2(weight)，weight<1 钳到 1（引擎再乘 edgeWidth） */
export function trunkEdgeWidth(weight: number): number {
  return 1 + Math.log2(Math.max(weight, 1));
}

/** 簇色 = 簇 id charCode 累加 hash 进 NODE_TYPE_COLORS 去重调色板（确定性；同色邻居 v1 接受，设计 §六） */
export function trunkClusterColor(id: string): string {
  const palette = [...new Set(Object.values(NODE_TYPE_COLORS))];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash + id.charCodeAt(i)) % 997;
  return palette[hash % palette.length]!;
}
