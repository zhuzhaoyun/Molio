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
// 和弱排斥力，最终随机散布。Obsidian 用 tile 把孤立/外围节点平铺成网格/
// 圆环。这里用同心圆环：以连接节点质心为中心，在连接节点包围半径之外，
// 把孤立节点按角度均匀排成一圈圈的环，并用 fx/fy 固定，使其不被后续力
// 模拟拉走。圆环一旦建立，Sigma 的 autoRescale 会把整图 fit 进视口，
// 中心簇在画面中占比自然缩小，"连线糊成团"的观感随之缓解。
const RING_SPACING = 12; // 环上节点间距 + 相邻环间距（graph units）

/**
 * 把 degree=0 的可见节点平铺成围绕连接节点簇的同心圆环，并固定 fx/fy。
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

  // 圆环起始半径：在连接簇之外留出空隙；无连接节点时退化为小圈
  let r = connected.length > 0 ? maxR * 1.6 + 30 : 30;
  let idx = 0;
  const n = isolated.length;
  while (idx < n) {
    const circumference = 2 * Math.PI * r;
    let count = Math.max(1, Math.floor(circumference / RING_SPACING));
    count = Math.min(count, n - idx);
    for (let i = 0; i < count; i++) {
      const angle = (2 * Math.PI * i) / count;
      const x = cx + r * Math.cos(angle);
      const y = cy + r * Math.sin(angle);
      const k = isolated[idx + i]!;
      graph.setNodeAttribute(k, 'x', x);
      graph.setNodeAttribute(k, 'y', y);
      // 固定位置：阻止后续力模拟把孤立节点拉回中心，维持圆环结构
      graph.setNodeAttribute(k, 'fx', x);
      graph.setNodeAttribute(k, 'fy', y);
    }
    idx += count;
    r += RING_SPACING;
  }
}
