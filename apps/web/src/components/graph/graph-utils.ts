// apps/web/src/components/graph/graph-utils.ts
// GraphPage 与 LocalGraphPanel 共享的颜色/尺寸/插值纯函数。

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

// 局部图面板节点上限（深度 2-3 枢纽节点会爆量）
export const MAX_LOCAL_NODES = 200;

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
