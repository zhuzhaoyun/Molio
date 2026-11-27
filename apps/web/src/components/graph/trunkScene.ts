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
  /** 子域（递归分级，深度 ≤2）：仅超上限大簇携带；旧 payload 缺省 = 平面渲染（fail-open） */
  children?: TrunkCluster[];
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
    clusters: c.clusters.map(function toTrunkCluster(x: {
      id: string;
      label: string;
      size: number;
      memberIds: string[];
      children?: unknown;
    }): TrunkCluster {
      const base: TrunkCluster = { id: x.id, label: x.label, size: x.size, memberIds: x.memberIds };
      if (Array.isArray(x.children)) base.children = x.children.map(toTrunkCluster);
      return base;
    }),
    links: c.links.map((l) => ({ source: l.source, target: l.target, weight: l.weight })),
    crumbCount: c.crumbCount,
    quality: c.quality,
  };
}

// ─── 嵌套子域（换核设计 §五：形态 A——确定性排布 + 标签预算）───

/** 子域标签预算：按 size 降序前 5 常显，其余「+K」计数（hover 浮现完整名走 labelLod forceShow） */
export const CHILD_LABEL_BUDGET = 5;

export interface ChildLabelBudget {
  /** 常显标签的子域 id（size 降序前 N，同 size 按 id 字典序稳定） */
  visible: string[];
  /** 未显示标签的子域数（渲染「+K」） */
  overflow: number;
}

export function budgetChildLabels(children: readonly TrunkCluster[], max = CHILD_LABEL_BUDGET): ChildLabelBudget {
  const sorted = [...children].sort((a, b) => (b.size - a.size || (a.id < b.id ? -1 : 1)));
  const visible = sorted.slice(0, max).map((c) => c.id);
  return { visible, overflow: Math.max(0, children.length - visible.length) };
}

/**
 * 子域确定性排布（换核设计 §五：不进 TRUNK_FORCE，容器内静态相对布局，随父团平移）。
 * 贪心环装：按 size 降序、首子居中、其余逐环外扩（同环按累计弧长步进角度），
 * 超出父团可用半径则整体等比收缩——**构造性保证两两不重叠且包络在父团内**。
 * 纯函数确定性：同输入两次调用逐字段相等。
 */
export interface ChildPlacement {
  x: number;
  y: number;
  r: number;
}

const CHILD_GAP = 2;
const CHILD_FILL = 0.82; // 可用半径 = 父团半径 × CHILD_FILL

export function layoutChildClusters(
  children: readonly TrunkCluster[],
  parentRadius: number,
): Map<string, ChildPlacement> {
  const placed = new Map<string, ChildPlacement>();
  if (children.length === 0 || parentRadius <= 0) return placed;

  // 子域半径 ∝ √size（与 trunkBlobRadius 同构）
  const radiusOf = (size: number): number => 2 + Math.sqrt(size);
  const avail = parentRadius * CHILD_FILL;
  const sorted = [...children].sort((a, b) => (b.size - a.size || (a.id < b.id ? -1 : 1)));

  // 弦距 → 角步（两圆在半径 R 的环上不重叠所需的最小夹角）
  const dTheta = (ra: number, rb: number, R: number): number =>
    2 * Math.asin(Math.min(1, (ra + rb + CHILD_GAP) / (2 * R)));

  const raw: Array<{ id: string; d: number; angle: number; r: number }> = [];
  let ringR = 0; // 当前环半径（首子域在圆心，d=0）
  let ringTheta = 0; // 当前环已占用角（累计 dTheta）
  let ringMaxR = 0; // 当前环最大子域半径（定下一环径向起点）
  let prevOnRing: { angle: number; r: number } | null = null;
  let ringIndex = 0;
  for (const c of sorted) {
    const r = radiusOf(c.size);
    if (raw.length === 0) {
      raw.push({ id: c.id, d: 0, angle: 0, r });
      ringMaxR = r;
      continue;
    }
    const need = prevOnRing ? dTheta(prevOnRing.r, r, ringR) : 0;
    if (ringR === 0 || ringTheta + need > 2 * Math.PI) {
      // 开新环：径向与上一环外缘 + 本子域半径 + GAP 隔开
      ringR = ringR === 0 ? ringMaxR + r + CHILD_GAP : ringR + ringMaxR + r + CHILD_GAP;
      ringTheta = 0;
      ringMaxR = 0;
      ringIndex++;
      prevOnRing = null;
    }
    const angle: number = prevOnRing ? prevOnRing.angle + dTheta(prevOnRing.r, r, ringR) : ringIndex * 1.1;
    raw.push({ id: c.id, d: ringR, angle, r });
    ringTheta += prevOnRing ? dTheta(prevOnRing.r, r, ringR) : 0;
    ringMaxR = Math.max(ringMaxR, r);
    prevOnRing = { angle, r };
  }

  // 包络超出父团可用半径 → 等比收缩（等比保不重叠与包络内）
  const outer = raw.reduce((m, p) => Math.max(m, p.d + p.r), 0);
  const scale = outer > avail ? avail / outer : 1;
  for (const p of raw) {
    placed.set(p.id, {
      x: Math.cos(p.angle) * p.d * scale,
      y: Math.sin(p.angle) * p.d * scale,
      r: p.r * scale,
    });
  }
  return placed;
}

/**
 * 质心校正（换核设计 §五）：布局 worker 就绪后，把基础排布向「成员质心（父团相对系）」
 * 混合 50%，再跑分离迭代修重叠、钳回父团可用圆内。幂等（每次都从基础排布重算，同输入
 * 同输出）；无质心的子域保持基础排布。**一次校正**（调用方守一次性），不引入常驻动画。
 */
export function blendChildPlacements(
  children: readonly TrunkCluster[],
  parentRadius: number,
  centroids: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, ChildPlacement> {
  const base = layoutChildClusters(children, parentRadius);
  if (children.length === 0 || centroids.size === 0) return base;
  const avail = parentRadius * CHILD_FILL;

  const pos = new Map<string, { x: number; y: number; r: number }>();
  for (const c of children) {
    const b = base.get(c.id);
    if (!b) continue;
    const g = centroids.get(c.id);
    if (!g) {
      pos.set(c.id, { ...b });
      continue;
    }
    let x = (b.x + g.x) / 2;
    let y = (b.y + g.y) / 2;
    const d = Math.hypot(x, y);
    const maxD = Math.max(0, avail - b.r);
    if (d > maxD && d > 0) {
      x = (x / d) * maxD;
      y = (y / d) * maxD;
    }
    pos.set(c.id, { x, y, r: b.r });
  }

  const clampIn = (p: { x: number; y: number; r: number }): void => {
    const d = Math.hypot(p.x, p.y);
    const maxD = Math.max(0, avail - p.r);
    if (d > maxD && d > 0) {
      p.x = (p.x / d) * maxD;
      p.y = (p.y / d) * maxD;
    }
  };
  for (let iter = 0; iter < 8; iter++) {
    const list = children.map((c) => pos.get(c.id)).filter((p): p is { x: number; y: number; r: number } => !!p);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 1e-9;
        const min = a.r + b.r + CHILD_GAP;
        if (dist >= min) continue;
        const push = (min - dist) / 2;
        const ux = dx / dist;
        const uy = dy / dist;
        a.x -= ux * push;
        a.y -= uy * push;
        b.x += ux * push;
        b.y += uy * push;
      }
    }
    for (const p of pos.values()) clampIn(p);
  }

  const out = new Map<string, ChildPlacement>();
  for (const [id, p] of pos) out.set(id, { x: p.x, y: p.y, r: p.r });
  return out;
}

/** 深 id 解析（c1 / c1.2 / c1.2.3）：顶层与全部后代里找；不存在 → null */
export function findClusterDeep(clusters: readonly TrunkCluster[], id: string): TrunkCluster | null {
  for (const c of clusters) {
    if (c.id === id) return c;
    if (c.children) {
      const found = findClusterDeep(c.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** 搜索候选拍平（换核设计 §五·搜索联动）：顶层 + 子域（标签「父·子」，id 为嵌套 id） */
export function flattenSearchableClusters(
  clusters: readonly TrunkCluster[],
): Array<{ id: string; label: string; size: number }> {
  const out: Array<{ id: string; label: string; size: number }> = [];
  for (const c of clusters) {
    out.push({ id: c.id, label: c.label, size: c.size });
    for (const ch of c.children ?? []) out.push({ id: ch.id, label: `${c.label}·${ch.label}`, size: ch.size });
  }
  return out;
}

export type TrunkViewReason = 'ok' | 'off' | 'no-communities' | 'filters';

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

/**
 * trunk 态出图卡片的统计行：描述**画面上的 trunk 对象**（簇/枢纽数），不是全库计数——
 * 截图是 trunk 画布（几个团），统计写「511 篇」就是卡片对图面撒谎（GraphPage 出图红线：
 * 「图里 300 个点、标题写 1284 篇——比不写更糟」；终审 Important-3）。
 * label 由调用方传 i18n 文案。
 */
export function trunkExportMeta(
  scene: TrunkScene,
  clusterLabel: string,
  hubLabel: string,
  expandedCount = 0,
  expandedLabel = '已展开',
): string {
  const parts: string[] = [];
  if (scene.clusters.length > 0) {
    // H2 混合场景（代拍 Q）：展开簇的 blob 不在画布上，计数后显式标注展开数——守「所见即所写」。
    // 换核 v1 只数一级簇（子域不计数——嵌套形态下「簇 N」指顶层容器数；子域计数待用户反馈再定）
    parts.push(
      expandedCount > 0
        ? `${clusterLabel} ${scene.clusters.length}（${expandedLabel} ${expandedCount}）`
        : `${clusterLabel} ${scene.clusters.length}`,
    );
  }
  if (scene.hubs.length > 0) parts.push(`${hubLabel} ${scene.hubs.length}`);
  return parts.join(' · ');
}
