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
// 外围结构。这里以连接节点质心为中心，从中心簇外缘（rIn≈1.3× 包围半径）
// 起，用黄金角螺旋（phyllotaxis）按**固定点间距**向外排成均匀密点云——
// 不用同心环（各环角度对齐会产生放射状辐条）。点间距与中心簇尺度挂钩
// （≈0.15× 包围半径），使外围密度始终和中心簇协调。
//
// 为什么固定间距而非"固定环带面积撒点"：后者环带面积由包围半径定、与孤立
// 点数 n 无关，n 不够填满时就稀疏、还露出螺旋臂条纹。固定间距下外径随 n
// 自适应——n 少环带窄（密且中心占比高），n 多外径按 sqrt(n) 慢增长（孤立
// 点真多时外围本就该大，Obsidian 的网格 tile 也如此），故无需硬封顶。早期
// "无限外扩同心环"曾把包围盒撑巨大、中心压成小点，固定间距+sqrt 增长不会。
//
// 所有平铺节点用 fx/fy 固定，使其不被后续力模拟拉回中心。

/** 外围点云内缘相对连接簇包围半径的倍数（在中心簇外留空隙）。 */
const RING_IN_FACTOR = 1.3;

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

  // 连接节点"典型"包围半径：用 90 分位距离而非最大值。少数被长边甩远的
  // 离群连接节点会把 max 撑得巨大，进而把环带半径和环数都带飞——曾导致
  // 孤立节点每环只分到 2 个、退化成左右两条水平直线。分位数对离群点稳健。
  const dists: number[] = [];
  for (const k of connected) {
    const x = (graph.getNodeAttribute(k, 'x') as number) ?? 0;
    const y = (graph.getNodeAttribute(k, 'y') as number) ?? 0;
    dists.push(Math.hypot(x - cx, y - cy));
  }
  dists.sort((a, b) => a - b);
  const maxR =
    dists.length === 0
      ? 0
      : dists.length < 10
        ? dists[dists.length - 1]!
        : dists[Math.floor(dists.length * 0.9)]!;

  // 外围点云内缘：在中心簇之外留一点空隙；无连接节点时退化为绝对小圈。
  const rIn = connected.length > 0 ? Math.max(maxR * RING_IN_FACTOR, 18) : 24;
  // 点间距与中心簇尺度挂钩：maxR 大 → 中心簇节点间距大 → 外围也跟着疏一点，
  // 使外围密度始终与中心簇协调。关键——用**固定间距、外径自适应**，而非上一版
  // 的"固定环带面积撒点"：后者环带面积由 maxR 定、与孤立点数 n 无关，n 不够
  // 填满时就稀疏、还露出螺旋臂条纹。固定间距下 n 少 → 环带自动收窄 → 既密、
  // 中心占比又高；n 多 → 外径按 sqrt(n) 慢增长（孤立点真多时外围本就该大，
  // Obsidian 的网格 tile 也是如此），因此不再需要硬封顶。
  const spacing = Math.max(8, maxR * 0.15);

  // 黄金角螺旋（phyllotaxis，向日葵籽排布）：角度按黄金角旋转、半径按面积
  // 外扩（r² 每点增加 spacing²），形成均匀密点云——无圈痕、无放射状辐条。
  const n = isolated.length;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const rIn2 = rIn * rIn;
  const step = spacing * spacing;
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(rIn2 + i * step);
    const angle = i * GOLDEN_ANGLE;
    const x = cx + r * Math.cos(angle);
    const y = cy + r * Math.sin(angle);
    const k = isolated[i]!;
    graph.setNodeAttribute(k, 'x', x);
    graph.setNodeAttribute(k, 'y', y);
    // 固定位置：阻止后续力模拟把孤立节点拉回中心，维持外围点云结构
    graph.setNodeAttribute(k, 'fx', x);
    graph.setNodeAttribute(k, 'fy', y);
  }
}
