/**
 * graphUtils — 图谱引擎的纯函数集合（零 pixi/d3 依赖，可 node:test 直测）。
 *
 * 从 pixiGraphEngine.ts 抽取的无副作用计算：边去重、自动连线强度、
 * fit 视口变换、缓动与数值钳制。引擎只做胶水调用，逻辑以此文件为准。
 */

export interface EdgeLike {
  source: string;
  target: string;
}

/** 数值钳制到 [min, max] */
export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** easeCubicOut：1 - (1-t)^3，起始快、收尾缓 */
export function easeCubicOut(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/**
 * 边清洗：去自环、去无效端点、无向去重（A→B 与 B→A 视为同一条）。
 *
 * @param edges 原始边列表
 * @param nodeExists 端点存在性判断（通常传 nodeByKey.has）
 * @returns 清洗后的边（保留首次出现方向）
 */
export function dedupeEdges(edges: EdgeLike[], nodeExists: (key: string) => boolean): EdgeLike[] {
  const seen = new Set<string>();
  const out: EdgeLike[] = [];
  for (const e of edges) {
    if (e.source === e.target) continue;
    if (!nodeExists(e.source) || !nodeExists(e.target)) continue;
    const id = e.source < e.target ? `${e.source} ${e.target}` : `${e.target} ${e.source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

/**
 * d3 forceLink 默认强度公式：1 / min(deg_source, deg_target)。
 * hub（高度数节点）的连线自动变软，避免把邻居拽成一团。
 *
 * @param adjacency 邻接表（key → 邻居集合）
 * @returns 可直接传给 forceLink().strength() 的函数
 */
export function makeAutoLinkStrength(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
): (l: { sourceKey: string; targetKey: string }) => number {
  return (l) => {
    const ds = Math.max(adjacency.get(l.sourceKey)?.size ?? 1, 1);
    const dt = Math.max(adjacency.get(l.targetKey)?.size ?? 1, 1);
    return 1 / Math.min(ds, dt);
  };
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface LabelBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Obsidian 式标签去重：按优先级（输入顺序，越靠前越优先）贪心放置，
 * 与已放置标签重叠的条目被剔除——任何缩放级别下可见标签永不重叠。
 *
 * @param boxes 标签包围盒，按优先级降序
 * @param pinned 各条目是否「钉住」（焦点相关标签：互相允许重叠且总是显示，
 *        同时占据空间、剔除与之重叠的普通标签）
 * @returns 与输入等长的显示标志数组
 */
export function greedyLabelLayout(boxes: LabelBox[], pinned?: boolean[]): boolean[] {
  const placed: LabelBox[] = [];
  const visible: boolean[] = new Array(boxes.length).fill(false);
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    const pin = pinned?.[i] ?? false;
    let collides = false;
    for (const p of placed) {
      if (b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0) {
        collides = true;
        break;
      }
    }
    if (pin || !collides) {
      visible[i] = true;
      placed.push(b);
    }
  }
  return visible;
}

/**
 * 由节点包围盒计算「全图适配」视口变换（screen = graph * k + t）。
 * 保持宽高比，四周留 pad 像素边距，k 钳制到 [kMin, kMax]。
 */
export function computeFitTransform(
  bounds: Bounds,
  screenW: number,
  screenH: number,
  pad: number,
  kMin: number,
  kMax: number,
): { tx: number; ty: number; k: number } {
  const bw = Math.max(bounds.maxX - bounds.minX, 1);
  const bh = Math.max(bounds.maxY - bounds.minY, 1);
  const k = clamp(Math.min((screenW - pad * 2) / bw, (screenH - pad * 2) / bh), kMin, kMax);
  const tx = screenW / 2 - ((bounds.minX + bounds.maxX) / 2) * k;
  const ty = screenH / 2 - ((bounds.minY + bounds.maxY) / 2) * k;
  return { tx, ty, k };
}
