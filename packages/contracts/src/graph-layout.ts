/**
 * 图谱布局配方——单一来源（H3 种子初始位置，docs/2026-11-25-graph-h3-seeded-positions-design.md）。
 *
 * 这些值此前散在 web 引擎（pixiGraphEngine 的 DISTANCE_MIN/CONTAIN_STRENGTH/COLLIDE_ITERATIONS、
 * graphUtils 的 COLLIDE_*、types 的 DEFAULT_FORCE_PARAMS、layoutWorker 的 strength 分支）。
 * daemon worker 预跑要用**同款配方**算布局种子——两侧漂移 = 种子失真 + 浏览器精修大动，
 * 所以常量与纯函数提到 contracts 钉死。
 *
 * 约束：本文件**零运行时依赖**（不 import d3-force——dsh-plugin 对 contracts 是
 * type-only 引用，包必须保持可被任意端零成本引入）。force 对象的装配（创建
 * forceManyBody/forceLink/…）由两侧各自完成：web 在 pixiGraphEngine/layoutWorker，
 * daemon 在 core/graph-prerun。
 */

/** 全量图力配方（v3，与 web DEFAULT_FORCE_PARAMS + 引擎常量逐字一致）。 */
export const GRAPH_LAYOUT_RECIPE = {
  /** forceManyBody strength（types.ts DEFAULT_FORCE_PARAMS.repelStrength） */
  repelStrength: -120,
  /** forceCenter strength */
  centerStrength: 0.2,
  /** forceLink distance */
  linkDistance: 250,
  /** forceLink strength：0 = d3 默认按度数加权（见 autoLinkStrength） */
  linkStrength: 0,
  /** forceManyBody distanceMin——封 1/d² 电荷爆（引擎 DISTANCE_MIN） */
  distanceMin: 20,
  /** forceX/forceY contain strength（引擎 CONTAIN_STRENGTH） */
  containStrength: 0.06,
  /** forceCollide iterations（引擎 COLLIDE_ITERATIONS） */
  collideIterations: 3,
  /** super-hub 度数门槛（graphUtils SUPER_HUB_DEGREE） */
  superHubDegree: 60,
  /** collide 半径公式 r×collideMult+collidePad，封顶 collideMax */
  collideMult: 5,
  collidePad: 4,
  collideMax: 100,
} as const;

/** collide 半径（引擎/mini-sim/布局 worker 共用同一公式；graphUtils.collideRadiusValue 的来源）。 */
export function collideRadiusValue(radius: number): number {
  return Math.min(radius * GRAPH_LAYOUT_RECIPE.collideMult + GRAPH_LAYOUT_RECIPE.collidePad, GRAPH_LAYOUT_RECIPE.collideMax);
}

/**
 * 自动链强度（linkStrength=0 时的 d3 默认语义）：1/min(deg)；一端是 super-hub
 * （>superHubDegree）则 1/√max(deg)——防「几百条源边把 hub 甩飞」。
 */
export function autoLinkStrength(degSource: number, degTarget: number): number {
  const ds = Math.max(degSource, 1);
  const dt = Math.max(degTarget, 1);
  const hi = Math.max(ds, dt);
  if (hi > GRAPH_LAYOUT_RECIPE.superHubDegree) return 1 / Math.sqrt(hi);
  return 1 / Math.min(ds, dt);
}

/** 浏览器低温精修档（设计 §3.3）：全量种子 α=0.1 / 部分种子 α=0.3，加速衰减 ~65 ticks 烧完。 */
export const REFINE_ALPHA_FULL = 0.1;
export const REFINE_ALPHA_PARTIAL = 0.3;
export const REFINE_ALPHA_DECAY = 0.06;
/** 种子覆盖率门槛（≥ 此值走全量精修档；也是 daemon 投递门槛）。 */
export const REFINE_COVERAGE = 0.8;

/** 布局种子：[节点 key, x, y]（坐标已取整 1 位小数）。 */
export type GraphPositions = Array<[string, number, number]>;
