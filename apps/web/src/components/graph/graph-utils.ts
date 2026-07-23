// apps/web/src/components/graph/graph-utils.ts
// GraphPage 使用的颜色/尺寸/插值纯函数。

import type Graph from 'graphology';

// 节点颜色 — 3 阶灰度 + 2 强调色
export const NODE_TYPE_COLORS: Record<string, string> = {
  document:   '#8899AA',
  source:     '#8899AA',
  wiki:       '#7A8A99',
  concept:    '#8B5CF6',
  entity:     '#8B5CF6',
  comparison: '#D97706',
  question:   '#D97706',
  tag:        '#8B5CF6',
  agent:      '#8B5CF6',
  project:    '#8899AA',
  workflow:   '#D97706',
  aiModel:    '#D97706',
};

/** 节点大小按连接数动态变化（Obsidian 风格：小 3px 大 9px）。 */
export function nodeSize(linkCount: number, scale: number = 1.0): number {
  const base = 2;
  const maxSize = 8;
  const calculated = (base + Math.sqrt(linkCount) * 1.2) * scale;
  return Math.min(maxSize * scale, calculated);
}

export function nodeColor(linkCount: number, nodeType?: string): string {
  if (nodeType && NODE_TYPE_COLORS[nodeType]) {
    return NODE_TYPE_COLORS[nodeType]!;
  }
  if (linkCount === 0) return '#999999';
  return '#5C5C5C';
}

/** Interpolate between two hex colors by `t` (0→1). */
export function interpolateColor(a: string, b: string, t: number): string {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const parse = (c: string) => {
    const h = c.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  try {
    const [ar, ag, ab] = parse(a);
    const [br, bg, bb] = parse(b);
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `#${rr.toString(16).padStart(2, '0')}${rg.toString(16).padStart(2, '0')}${rb.toString(16).padStart(2, '0')}`;
  } catch {
    return t > 0.5 ? b : a;
  }
}

// ── 孤立节点外围平铺（对齐 Obsidian CoSE 的 tile）──
//
// 力导向无法把 degree=0 的节点排成规整结构：它们没有边约束，只受向心力
// 和弱排斥力，最终随机散布。Obsidian 用 tile 把孤立/外围节点平铺成规整的
// 外围结构。这里用一个**封顶的环形带**：以连接节点质心为中心，环带内/外
// 半径都锁定为连接簇包围半径的固定倍数（rIn≈1.3×、rOut≈2.6×）。孤立节点
// 在带内排成同心环；节点多时让环排密一点（缩小 spacing），而不是向外扩环。
//
// 为什么封顶：早期版本让环从 1.6× 起步、以固定间距无限外扩，结果当中心簇
// 因连接距离短而收得很紧时，外围环膨胀到中心簇的好几倍，把整图包围盒撑得
// 巨大——Sigma 的 autoRescale fit 全图后，中心被压成一个小点，相机无法放大
// 看节点细节。封顶后包围盒半径始终 ≈ 2.6× 中心簇半径，fit 后中心稳定占视口
// 约 40%，可正常缩放查看。
//
// 所有平铺节点用 fx/fy 固定，使其不被后续力模拟拉回中心。

/** 环带内/外半径相对连接簇包围半径的倍数。 */
const RING_IN_FACTOR = 1.3;
const RING_OUT_FACTOR = 2.6;
/** 期望环间距（graph units），用于决定环带内排几圈环。 */
const RING_GAP = 12;

/**
 * 把 degree=0 的可见节点平铺成围绕连接节点簇的封顶环形带，并固定 fx/fy。
 * 必须在力模拟收敛之后调用（用收敛后的连接节点位置计算质心/半径）。
 */
export function tileIsolatedNodes(graph: Graph): void {
  const connected: string[] = [];
  const isolated: string[] = [];
  graph.forEachNode((key, attrs) => {
    if (attrs.hidden) return;
    if (graph.degree(key) === 0) isolated.push(key);
    else connected.push(key);
  });
  if (isolated.length === 0) return;

  // 连接节点质心
  let cx = 0;
  let cy = 0;
  for (const k of connected) {
    cx += (graph.getNodeAttribute(k, 'x') as number) ?? 0;
    cy += (graph.getNodeAttribute(k, 'y') as number) ?? 0;
  }
  if (connected.length > 0) {
    cx /= connected.length;
    cy /= connected.length;
  }

  // 连接节点包围半径（质心到最远连接节点）
  let maxR = 0;
  for (const k of connected) {
    const x = (graph.getNodeAttribute(k, 'x') as number) ?? 0;
    const y = (graph.getNodeAttribute(k, 'y') as number) ?? 0;
    const d = Math.hypot(x - cx, y - cy);
    if (d > maxR) maxR = d;
  }

  // 封顶环带：内/外半径与中心簇成比例；无连接节点时退化为绝对小圈。
  // 关键——rOut 是包围盒半径的硬上限，绝不向外突破，否则中心簇会被
  // autoRescale 压成小点、相机无法放大查看（见函数头注释）。
  const rIn = connected.length > 0 ? Math.max(maxR * RING_IN_FACTOR, 18) : 24;
  const rOut = connected.length > 0 ? Math.max(maxR * RING_OUT_FACTOR, 48) : 96;

  // 环带内的环半径（线性分布在内/外半径之间，环间距≈RING_GAP）
  const nRings = Math.max(1, Math.floor((rOut - rIn) / RING_GAP) + 1);
  const ringRadii: number[] = [];
  for (let i = 0; i < nRings; i++) {
    ringRadii.push(nRings > 1 ? rIn + (rOut - rIn) * (i / (nRings - 1)) : (rIn + rOut) / 2);
  }

  // 按各环周长比例把孤立节点分配到各环（最大余数法，保证总数精确 = n）。
  // 外环周长大、分得多，内环分得少——重叠（节点过多时不可避免）尽量发生
  // 在不显眼的外环，而非靠近中心的内环。节点再多也只让环排密/重叠，
  // 绝不向外扩环，从而严格守住 rOut 这个包围盒上限。
  const n = isolated.length;
  const circumferences = ringRadii.map((r) => 2 * Math.PI * r);
  const totalCirc = circumferences.reduce((s, c) => s + c, 0);
  const raw = circumferences.map((c) => (n * c) / totalCirc);
  const perRing = raw.map((v) => Math.floor(v));
  let allocated = perRing.reduce((s, c) => s + c, 0);
  const remainderOrder = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let j = 0; allocated < n; j++) perRing[remainderOrder[j % remainderOrder.length]!.i]++, allocated++;

  let idx = 0;
  for (let ri = 0; ri < nRings && idx < n; ri++) {
    const r = ringRadii[ri]!;
    const count = Math.min(perRing[ri]!, n - idx);
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      const k = isolated[idx + i]!;
      graph.setNodeAttribute(k, 'x', x);
      graph.setNodeAttribute(k, 'y', y);
      // 固定位置：阻止后续力模拟把孤立节点拉回中心，维持环形带结构
      graph.setNodeAttribute(k, 'fx', x);
      graph.setNodeAttribute(k, 'fy', y);
    }
    idx += count;
  }
}
