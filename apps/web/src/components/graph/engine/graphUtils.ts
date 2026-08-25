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
 * 超级 hub 度数阈值：度数超过它的一条边会被按 1/√deg 减弱。
 * 普通图（度数 ≤ 阈值）完全不变；但像资治通鉴里 deg-683 的「源/索引」节点，
 * 其 683 条 1/min(deg)=1 的强弹簧会在任何拖拽扰动下把 hub 甩飞（实测 3350u 瞬移）。
 * 用 1/√max 把这种超级 hub 的连线收敛到弱约束，不让单个节点成为「力放大镜」。
 */
export const SUPER_HUB_DEGREE = 60;

/**
 * d3 forceLink 默认强度公式：1 / min(deg_source, deg_target)。
 * hub（高度数节点）的连线自动变软，避免把邻居拽成一团。
 * 仅当一端是超级 hub（度数 > SUPER_HUB_DEGREE）时改为 1/√max，压制极端 hub 的漂移放大。
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
    const hi = Math.max(ds, dt);
    if (hi > SUPER_HUB_DEGREE) return 1 / Math.sqrt(hi);
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

// ── 平铺输入 ──

/** 孤立平铺输入：需带坐标与度数（孤立判定用）。 */
export interface GraphDegreeNode {
  id: string;
  x: number;
  y: number;
  degree: number;
}

// ── 孤立节点外围平铺（对齐 Obsidian CoSE 的 tile）──
// force 无法把 degree=0 节点排成规整结构：它们没有边约束，只受向心力与弱排斥力，
// 最终随机散布。这里以连接节点质心为中心，从中心簇外缘（rIn≈1.3×包围半径）起，
// 用黄金角螺旋（phyllotaxis）按**固定点间距**向外排成均匀密点云——不用同心环
// （各环角度对齐会产生放射状辐条）。点间距与中心簇尺度挂钩（≈0.15×包围半径），
// 使外围密度始终与中心簇协调。
//
// 为什么固定间距而非固定环带面积撒点：后者环带面积由包围半径定、与孤立点数无关，
// n 不够填满时就稀疏、还露出螺旋臂条纹。固定间距下外径随 n 自适应——n 少环带窄
// （密且中心占比高），n 多外径按 sqrt(n) 慢增长，故无需硬封顶。
//
// 布局时（或拖拽全流动解锁后重铺时）调用：外围节点用 fx/fy 固定，不被后续力模拟拉回。

/** 外围点云内缘相对连接簇包围半径的倍数（在中心簇外留空隙）。 */
const RING_IN_FACTOR = 1.3;

/**
 * 把 degree=0 节点平铺成围绕连接节点簇的外围圆环。
 * 必须在力模拟收敛后调用（用收敛后的连接节点位置计算质心/半径）。
 * @returns 仅含 degree=0 节点的目标位置；无孤立节点时返回空 Map。
 */
export function tileIsolatedNodes(
  nodes: Readonly<GraphDegreeNode[]>,
): Map<string, { x: number; y: number }> {
  const connected = nodes.filter((n) => n.degree > 0);
  const isolated = nodes.filter((n) => n.degree === 0);
  if (isolated.length === 0) return new Map();

  // 连接节点质心
  let cx = 0;
  let cy = 0;
  for (const n of connected) {
    cx += n.x;
    cy += n.y;
  }
  if (connected.length > 0) {
    cx /= connected.length;
    cy /= connected.length;
  }

  // 连接节点「典型」包围半径：用 90 分位距离而非最大值。少数被长边甩远的离群点
  // 会把 max 撑得巨大、把环带带飞——曾退化成分到 2 个的水平直线。分位数对离群稳健。
  const dists: number[] = [];
  for (const n of connected) dists.push(Math.hypot(n.x - cx, n.y - cy));
  dists.sort((a, b) => a - b);
  const maxR =
    dists.length === 0
      ? 0
      : dists.length < 10
        ? dists[dists.length - 1]!
        : dists[Math.floor(dists.length * 0.9)]!;

  // 内缘：在中心簇之外留一点空隙；无连接节点时退化为绝对小圈。
  const rIn = connected.length > 0 ? Math.max(maxR * RING_IN_FACTOR, 18) : 24;
  // 点间距与中心簇尺度挂钩（maxR 大 → 中心簇节点间距大 → 外围也疏一点），密度协调。
  const spacing = Math.max(8, maxR * 0.15);

  // 黄金角螺旋（向日葵籽排布）：角度按黄金角旋转、半径按面积外扩（r² 每点增加 spacing²）。
  // 形成均匀密点云——无圈痕、无放射状辐条。
  const n = isolated.length;
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const rIn2 = rIn * rIn;
  const step = spacing * spacing;
  const out = new Map<string, { x: number; y: number }>();
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(rIn2 + i * step);
    const angle = i * GOLDEN_ANGLE;
    const id = isolated[i]!.id;
    out.set(id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  }
  return out;
}
